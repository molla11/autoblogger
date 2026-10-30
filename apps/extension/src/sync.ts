import { Journal } from "./journal";
import { Recorder } from "./recorder";
import { SyncAck } from "./types";
import { validateServiceUrl } from "./safety";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function apiRequest<T>(
  base: string,
  token: string | undefined,
  route: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  validateServiceUrl(base);
  const response = await fetch(base.replace(/\/$/, "") + route, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    // Never echo a server body that could contain user data or credentials into the extension log.
    throw new HttpError(response.status, `API 요청 실패 (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export interface SyncOptions {
  apiUrl: string;
  token: string;
  journals: Journal[];
  active?: Recorder;
  onRemoteStop?: () => Promise<void>;
}

/** A sync cycle can be retried freely: client IDs and acknowledgement ranges are persistent. */
export async function syncJournals(options: SyncOptions): Promise<void> {
  const { apiUrl, token, journals } = options;
  const me = await apiRequest<{ id: string }>(apiUrl, token, "/me");
  const projects = await apiRequest<
    Array<{
      id: string;
      rootPath?: string;
      excluded?: boolean;
      excludePatterns?: string[];
    }>
  >(apiUrl, token, "/projects");
  for (const journal of journals) {
    if (journal.manifest.ownerId && journal.manifest.ownerId !== me.id)
      continue;
    if (journal.manifest.apiUrl && journal.manifest.apiUrl !== apiUrl) continue;
    if (!journal.manifest.projectId) {
      let project = projects.find(
        (project) => project.rootPath === journal.manifest.rootPath,
      );
      if (!project) {
        project = await apiRequest(apiUrl, token, "/projects", "POST", {
          name: journal.manifest.name,
          rootPath: journal.manifest.rootPath,
          excludePatterns: journal.manifest.excludePatterns,
        });
        projects.push(project!);
      }
      await journal.update({ projectId: project!.id, ownerId: me.id, apiUrl });
    }
    const project = projects.find(
      (project) => project.id === journal.manifest.projectId,
    );
    if (project?.excludePatterns)
      await journal.update({
        remoteExcludePatterns: project.excludePatterns,
        excludePatterns: [
          ...new Set([
            ...journal.manifest.excludePatterns,
            ...project.excludePatterns,
          ]),
        ],
      });
    if (project?.excluded && options.active?.journal === journal) {
      await options.onRemoteStop?.();
    }
    if (!journal.manifest.serverCreated) {
      await apiRequest(
        apiUrl,
        token,
        `/projects/${encodeURIComponent(journal.manifest.projectId!)}/sessions`,
        "POST",
        {
          id: journal.manifest.id,
          startedAt: journal.manifest.startedAt,
        },
      );
      await journal.update({ serverCreated: true });
    } else if (journal.manifest.recording) {
      const remote = await apiRequest<{
        session: { recording?: boolean; endedAt?: string };
      }>(apiUrl, token, `/sessions/${journal.manifest.id}`);
      if (remote.session.recording === false || remote.session.endedAt) {
        if (options.active?.journal === journal) await options.onRemoteStop?.();
        else await new Recorder(journal).stop("remote");
      }
    }
    for (;;) {
      const batch = journal.pending();
      if (!batch.length) break;
      const ack = await apiRequest<SyncAck>(
        apiUrl,
        token,
        `/sessions/${journal.manifest.id}/events`,
        "POST",
        { events: batch },
      );
      const before = journal.pendingCount();
      await journal.acknowledge(
        ack,
        batch.map((event) => event.sequence),
      );
      if (journal.pendingCount() >= before)
        throw new Error(
          "서버가 기록 수신을 확인하지 않았습니다. 다음 동기화에서 재시도합니다.",
        );
    }
    if (journal.manifest.endedAt && !journal.manifest.serverEnded) {
      await apiRequest(
        apiUrl,
        token,
        `/sessions/${journal.manifest.id}`,
        "PATCH",
        { endedAt: journal.manifest.endedAt, recording: false },
      );
      await journal.update({ serverEnded: true });
    }
  }
}
