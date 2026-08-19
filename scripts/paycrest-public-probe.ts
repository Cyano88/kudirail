import { runPublicPaycrestProbe } from '../src/server/paycrest'

const result = await runPublicPaycrestProbe()
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
