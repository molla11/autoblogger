"use client";
import { useEffect, useState } from "react";
import { RefreshCw, Settings2, ShieldCheck } from "lucide-react";
import type { AdminData, User, Job } from "@/lib/types";
import { api, patch, post, money, date, errorMessage } from "@/lib/api";
import {
  Badge,
  Empty,
  PageHead,
  ShowMore,
  StatStrip,
  jobLabels,
  statusLabels,
} from "./ui";
export default function Admin({
  notify,
}: {
  notify: (s: string, error?: boolean) => void;
}) {
  const [data, setData] = useState<AdminData | null>(null),
    [model, setModel] = useState("openai/gpt-6.1-terra"),
    [provider, setProvider] = useState("Azure"),
    [signupPaused, setSignupPaused] = useState(false),
    [loading, setLoading] = useState(false),
    [allJobs, setAllJobs] = useState(false),
    [allRuns, setAllRuns] = useState(false),
    [allUsers, setAllUsers] = useState(false);
  async function refresh() {
    setLoading(true);
    try {
      const result = await api<AdminData>("/admin");
      setData(result);
      setModel(result.settings.model);
      setProvider(result.settings.provider);
      setSignupPaused(Boolean(result.settings.signupPaused));
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    try {
      await patch("/admin/settings", { model, provider, signupPaused });
      notify("이후 등록하는 AI 작업부터 새 설정을 적용합니다.");
      void refresh();
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function limits(user: User, dailyLimit: number, monthlyLimit: number) {
    try {
      await patch(`/admin/users/${user.id}`, { dailyLimit, monthlyLimit });
      notify("사용 한도를 저장했습니다.");
      void refresh();
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function retry(job: Job) {
    try {
      await post(`/jobs/${job.id}/retry`);
      notify("작업을 다시 등록했습니다.");
      void refresh();
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  const cost = (data?.modelRuns || []).reduce(
      (sum, run) => sum + Number(run.cost || 0),
      0,
    ),
    credit = data?.credit || {};
  return (
    <section className="admin-page">
      <PageHead
        title="운영 현황"
        description="사용량과 작업 상태를 확인하고 AI 설정을 관리하세요."
        actions={
          <button
            className="button subtle"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? "spin" : ""} />
            새로고침
          </button>
        }
      />
      <StatStrip
        items={[
          {
            label: "기록된 AI 비용",
            value: money(cost),
            hint: `${data?.modelRuns.length || 0}회 모델 호출`,
          },
          { label: "사용자", value: data?.users.length || 0, unit: "명" },
          {
            label: "실패 작업",
            value: data?.jobs.filter((j) => j.status === "failed").length || 0,
            unit: "건",
            hint: "원본을 보존하고 재시도",
          },
          {
            label: "기록이 완성된 글로 이어진 비율",
            value: `${Math.round(Number(data?.metrics?.completionRate || 0) * 100)}%`,
            hint: `${Number(data?.metrics?.completedSessions || 0)} / ${Number(data?.metrics?.recordedSessions || 0)}개 세션 · 보관함 편집 완료 포함`,
          },
        ]}
      />
      {!!data?.alerts?.length && (
        <div className="notice warning">
          {data.alerts.map((alert, i) => (
            <p key={i}>
              {typeof alert === "string" ? alert : JSON.stringify(alert)}
            </p>
          ))}
        </div>
      )}
      <div className="settings-grid">
        <section className="card settings-card">
          <div className="card-title">
            <Settings2 size={18} />
            <h2>AI 모델과 provider</h2>
          </div>
          <form onSubmit={saveSettings}>
            <label>
              OpenRouter 모델 ID
              <input
                required
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </label>
            <label>
              Provider
              <input
                required
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={signupPaused}
                onChange={(e) => setSignupPaused(e.target.checked)}
              />
              신규 가입을 대기열로 받기
            </label>
            <p className="field-hint">
              현재 대기 {data?.waitlist?.length || 0}명. 기존 사용자는 계속
              이용할 수 있습니다.
            </p>
            <div className="notice">
              데이터 수집 거부 및 자동 fallback 금지는 유지됩니다. 이미 등록된
              작업은 등록 시점의 설정을 사용합니다.
            </div>
            <button className="button primary">AI 설정 저장</button>
          </form>
        </section>
        <section className="card settings-card">
          <div className="card-title">
            <ShieldCheck size={18} />
            <h2>키 사용 한도</h2>
          </div>
          <dl className="key-stats">
            {Object.keys(credit).length ? (
              Object.entries(credit)
                .filter(([k]) => !["label", "hash", "key"].includes(k))
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>
                      {typeof v === "object"
                        ? JSON.stringify(v)
                        : String(v ?? "제한 없음")}
                    </dd>
                  </div>
                ))
            ) : (
              <p className="muted">
                키 정보를 아직 조회하지 못했습니다. API 환경변수를 확인해
                주세요.
              </p>
            )}
          </dl>
          <p className="field-hint">
            사용률 50%·80% 경보는 이 대시보드에서 확인합니다. 이메일은 발송하지
            않습니다.
          </p>
        </section>
      </div>
      {!!data?.waitlist?.length && (
        <section className="card table-card">
          <div className="card-title">
            <h2>신규 가입 대기열</h2>
            <Badge>{data.waitlist.length}</Badge>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>이메일</th>
                  <th>신청 시각</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {data.waitlist.map((entry) => (
                  <tr key={entry.email}>
                    <td>{entry.email}</td>
                    <td>{date(entry.createdAt)}</td>
                    <td>가입 재개 대기</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="card table-card">
        <div className="card-title">
          <h2>사용자별 사용량과 상한</h2>
          <Badge>{data?.users.length || 0}</Badge>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>계정</th>
                <th>오늘 사용</th>
                <th>이번 달 사용</th>
                <th>일 상한 ($)</th>
                <th>월 상한 ($)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(allUsers
                ? data?.users || []
                : (data?.users || []).slice(0, 8)
              ).map((user) => (
                <UserLimits key={user.id} user={user} onSave={limits} />
              ))}
            </tbody>
          </table>
          <ShowMore
            total={data?.users.length || 0}
            limit={8}
            expanded={allUsers}
            onToggle={() => setAllUsers(!allUsers)}
          />
        </div>
      </section>
      <section className="card table-card">
        <div className="card-title">
          <h2>작업 현황</h2>
          <Badge>{data?.jobs.length || 0}</Badge>
        </div>
        {data?.jobs.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>작업</th>
                  <th>상태</th>
                  <th>등록 시각</th>
                  <th>오류</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(allJobs ? data.jobs : data.jobs.slice(0, 8)).map((job) => (
                  <tr key={job.id}>
                    <td>{jobLabels[job.kind] || job.kind}</td>
                    <td>
                      <Badge
                        tone={
                          job.status === "failed"
                            ? "red"
                            : job.status === "completed"
                              ? "green"
                              : "neutral"
                        }
                      >
                        {statusLabels[job.status] || job.status}
                      </Badge>
                    </td>
                    <td>{date(job.createdAt)}</td>
                    <td className="error-cell">{job.error || "—"}</td>
                    <td>
                      {job.status === "failed" && (
                        <button
                          className="button subtle"
                          onClick={() => void retry(job)}
                        >
                          재시도
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ShowMore
              total={data.jobs.length}
              limit={8}
              expanded={allJobs}
              onToggle={() => setAllJobs(!allJobs)}
            />
          </div>
        ) : (
          <Empty compact title="등록된 작업이 없습니다" />
        )}
      </section>
      <section className="card table-card">
        <div className="card-title">
          <h2>모델 호출 기록</h2>
          <Badge>{data?.modelRuns.length || 0}</Badge>
        </div>
        {data?.modelRuns.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>모델 / provider</th>
                  <th>프롬프트</th>
                  <th>비용</th>
                  <th>지연</th>
                  <th>시각</th>
                </tr>
              </thead>
              <tbody>
                {(allRuns
                  ? data?.modelRuns || []
                  : (data?.modelRuns || []).slice(0, 8)
                ).map((run, i) => (
                  <tr key={String(run.id || i)}>
                    <td>
                      {String(run.model || run.modelId || "—")}
                      <small>{String(run.provider || "—")}</small>
                    </td>
                    <td>{String(run.promptVersion || "—")}</td>
                    <td>{money(run.cost)}</td>
                    <td>
                      {Number(
                        run.durationMs || run.latencyMs || 0,
                      ).toLocaleString()}
                      ms
                    </td>
                    <td>{date(String(run.createdAt || ""))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ShowMore
              total={data?.modelRuns.length || 0}
              limit={8}
              expanded={allRuns}
              onToggle={() => setAllRuns(!allRuns)}
            />
          </div>
        ) : (
          <Empty compact title="모델 호출 기록이 없습니다" />
        )}
      </section>
    </section>
  );
}
function UserLimits({
  user,
  onSave,
}: {
  user: User;
  onSave: (u: User, d: number, m: number) => void;
}) {
  const [daily, setDaily] = useState(user.dailyLimit ?? 3),
    [monthly, setMonthly] = useState(user.monthlyLimit ?? 15);
  return (
    <tr>
      <td>
        {user.email}
        <small>{user.role === "admin" ? "관리자" : "사용자"}</small>
      </td>
      <td>{money(user.usage?.day)}</td>
      <td>{money(user.usage?.month)}</td>
      <td>
        <input
          type="number"
          aria-label={`${user.email} 일 상한`}
          min="0"
          step="0.1"
          value={daily}
          onChange={(e) => setDaily(Number(e.target.value))}
        />
      </td>
      <td>
        <input
          type="number"
          aria-label={`${user.email} 월 상한`}
          min="0"
          step="0.1"
          value={monthly}
          onChange={(e) => setMonthly(Number(e.target.value))}
        />
      </td>
      <td>
        <button
          className="button subtle"
          onClick={() => onSave(user, daily, monthly)}
        >
          저장
        </button>
      </td>
    </tr>
  );
}
