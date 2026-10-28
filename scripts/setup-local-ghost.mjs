import { mkdir, readFile, writeFile, access, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

// An isolated Linux x64 fixture, not production deployment tooling. No .env.local is read.
const root = "/tmp/autoblogger-ghost";
const tools = "/tmp/autoblogger-ghost-tools";
const origin = "http://127.0.0.1:2369";
const version = "6.67.0";
const exists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}`);
};
async function request(route, body) {
  const response = await fetch(origin + route, {
    headers: { "Content-Type": "application/json", Origin: origin },
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Local Ghost HTTP ${response.status}`);
  return response.json();
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error(
      "This isolated installer targets Linux x64. Follow docs/GHOST-TEST.md for other platforms.",
    );
  await mkdir(root, { recursive: true });
  await mkdir(tools, { recursive: true });
  let nodeDirectory;
  const remembered = path.join(tools, "node-dir.txt");
  if (await exists(remembered))
    nodeDirectory = (await readFile(remembered, "utf8")).trim();
  if (!nodeDirectory || !(await exists(path.join(nodeDirectory, "bin/node")))) {
    const checksumResponse = await fetch(
      "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt",
    );
    if (!checksumResponse.ok) throw new Error("Node checksum download failed");
    const line = (await checksumResponse.text())
      .split("\n")
      .find((line) => line.endsWith("-linux-x64.tar.xz"));
    if (!line) throw new Error("Supported Node archive not found");
    const [checksum, name] = line.trim().split(/\s+/);
    const response = await fetch(
      "https://nodejs.org/dist/latest-v22.x/" + name,
    );
    if (!response.ok) throw new Error("Node archive download failed");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== checksum)
      throw new Error("Node archive checksum mismatch");
    const archive = path.join(tools, name);
    await writeFile(archive, bytes);
    run("tar", ["-xf", archive, "-C", tools]);
    nodeDirectory = path.join(tools, name.replace(/\.tar\.xz$/, ""));
    await writeFile(remembered, nodeDirectory);
  }
  const env = {
    ...process.env,
    PATH:
      path.join(nodeDirectory, "bin") +
      ":" +
      path.join(tools, "node_modules/.bin") +
      ":" +
      process.env.PATH,
  };
  const node = path.join(nodeDirectory, "bin/node");
  if (!(await exists(path.join(tools, "node_modules/ghost-cli/bin/ghost")))) {
    run(
      path.join(nodeDirectory, "bin/npm"),
      [
        "install",
        "--prefix",
        tools,
        "ghost-cli@1.34.0",
        "pnpm@12.16.1",
        "--no-audit",
        "--no-fund",
      ],
      { env },
    );
  }
  if (!(await exists(path.join(root, "current/index.js")))) {
    run(
      node,
      [
        path.join(tools, "node_modules/ghost-cli/bin/ghost"),
        "install",
        version,
        "--development",
        "--db",
        "sqlite3",
        "--dbpath",
        path.join(root, "content/data/ghost.db"),
        "--process",
        "local",
        "--no-start",
        "--no-enable",
        "--no-prompt",
        "--no-stack",
        "--url",
        origin,
        "--port",
        "2369",
        "--dir",
        root,
      ],
      { env },
    );
  }
  const configPath = path.join(root, "config.development.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.mail = { transport: "SMTP", options: { jsonTransport: true } }; // Nodemailer JSON transport: never sends an email.
  config.logging = { transports: ["stdout"] };
  config.privacy = {
    useUpdateCheck: false,
    useGravatar: false,
    useRpcPing: false,
    useStructuredData: false,
  };
  await writeFile(configPath, JSON.stringify(config, null, 2));
  let ready = false;
  try {
    await request("/ghost/api/admin/authentication/setup/");
    ready = true;
  } catch {}
  if (!ready) {
    const log = await open(path.join(root, "server.log"), "a", 0o600);
    const child = spawn(node, ["current/index.js"], {
      cwd: root,
      env,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
    await log.close();
    await writeFile(path.join(root, "server.pid"), String(child.pid));
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await request("/ghost/api/admin/authentication/setup/");
        ready = true;
        break;
      } catch {}
    }
    if (!ready)
      throw new Error(
        "Local Ghost failed to initialize; inspect /tmp/autoblogger-ghost/server.log",
      );
  }
  const setup = await request("/ghost/api/admin/authentication/setup/");
  if (!setup.setup?.[0]?.status) {
    const { randomBytes } = await import("node:crypto");
    await request("/ghost/api/admin/authentication/setup/", {
      setup: [
        {
          name: "Autoblogger Local Test",
          email: "owner@autoblogger.invalid",
          password: randomBytes(24).toString("base64url"),
          blogTitle: "Autoblogger isolated test",
        },
      ],
    });
  }
  if (!(await exists(path.join(root, "test-credentials.json")))) {
    // Create a fixture integration with exactly Ghost's standard Admin Integration role.
    // DB bootstrap is restricted to the hard-coded temporary instance; all behavior tests use its HTTP API.
    const bootstrap = `import sqlite3,secrets,datetime,json,os
c=sqlite3.connect('/tmp/autoblogger-ghost/content/data/ghost.db')
i=secrets.token_hex(12); k=secrets.token_hex(12); s=secrets.token_hex(32)
now=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
role=c.execute("select id from roles where name='Admin Integration'").fetchone()[0]
c.execute('INSERT INTO integrations(id,type,name,slug,created_at,updated_at) VALUES(?,?,?,?,?,?)',(i,'custom','Autoblogger isolated test','autoblogger-isolated-test',now,now))
c.execute('INSERT INTO api_keys(id,type,secret,integration_id,role_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',(k,'admin',s,i,role,now,now))
c.commit();c.close()
fd=os.open('/tmp/autoblogger-ghost/test-credentials.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump({'url':'http://127.0.0.1:2369','key':k+':'+s},f)
`;
    run("python3", ["-c", bootstrap]);
  }
  process.stdout.write(
    `Ghost ${version} ready at ${origin}. Test key stored privately in ${root}/test-credentials.json.\n`,
  );
}
main().catch((error) => {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
});
