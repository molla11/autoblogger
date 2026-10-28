const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const {runTests,downloadAndUnzipVSCode} = require('/tmp/autoblogger-vscode-tools/node_modules/@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname,'../..');
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(),'autoblogger-vscode-host-'));
  const workspace = path.join(sandbox,'workspace'), userData = path.join(sandbox,'user-data');
  await fs.mkdir(path.join(workspace,'.vscode'),{recursive:true});
  await fs.writeFile(path.join(workspace,'solution.py'),"print('python-one')\n");
  await fs.writeFile(path.join(workspace,'solution.cpp'),'#include <iostream>\nint main(){std::cout << "cpp-one\\n";}\n');
  await fs.writeFile(path.join(workspace,'input.txt'),'2 3\n');
  await fs.writeFile(path.join(workspace,'.vscode/settings.json'),JSON.stringify({
    'terminal.integrated.shellIntegration.enabled':true,'terminal.integrated.defaultProfile.linux':'bash',
    'autoblogger.autoSync':false,'security.workspace.trust.enabled':false,
    'workbench.startupEditor':'none','window.restoreWindows':'none','telemetry.telemetryLevel':'off','update.mode':'none'
  }));
  const executable = await downloadAndUnzipVSCode({version:'1.144.0',cachePath:'/tmp/autoblogger-vscode-tools/downloads'});
  for (const stage of ['first','restart']) {
    await runTests({vscodeExecutablePath:executable,extensionDevelopmentPath:path.join(root,'apps/extension'),extensionTestsPath:path.join(__dirname,'suite.cjs'),
      extensionTestsEnv:{AUTOBLOGGER_TEST_SANDBOX:sandbox,AUTOBLOGGER_TEST_STAGE:stage},
      launchArgs:[workspace,'--user-data-dir',userData,'--extensions-dir',path.join(sandbox,'extensions'),'--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--no-sandbox','--disable-gpu']});
  }
  console.log('VSCODE_HOST_ARTIFACTS',sandbox);
  await fs.writeFile('/tmp/autoblogger-vscode-tools/latest-artifacts.txt',sandbox);
}
main().catch(error => {console.error(error);process.exitCode=1;});
