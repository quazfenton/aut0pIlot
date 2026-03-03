# PowerShell script to run git integration tests
$env:GIT_PATH = "C:\Program Files\Git\cmd\git.exe"
C:\Users\ceclabs\AppData\Roaming\npm\bun test tests/git-integration-validation.test.ts --reporter=verbose
