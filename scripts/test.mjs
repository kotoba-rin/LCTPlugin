import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testsDirectory = join(repositoryRoot, "tests");
const testFiles = readdirSync(testsDirectory)
  .filter((name) => /^test_.*\.js$/.test(name))
  .sort();

if (testFiles.length === 0) {
  console.error("No test_*.js files found in tests/.");
  process.exit(1);
}

let failed = 0;
for (const name of testFiles) {
  console.log(`\nRunning ${name}`);
  const result = spawnSync(process.execPath, [join(testsDirectory, name)], {
    cwd: repositoryRoot,
    stdio: "inherit",
    timeout: 60_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    failed += 1;
    const reason = result.error?.message
      || (result.signal ? `terminated by ${result.signal}` : `exit code ${result.status}`);
    console.error(`FAILED ${name}: ${reason}`);
  }
}

console.log(`\n${testFiles.length - failed}/${testFiles.length} test files passed.`);
process.exitCode = failed > 0 ? 1 : 0;
