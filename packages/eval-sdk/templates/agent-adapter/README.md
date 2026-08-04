# Sample Agent adapter

This unranked starter launches a fixed sample-agent binary inside the trial sandbox. Rename the package, descriptor ID, binary, event normalization, and version discovery. Do not execute the Agent on the Worker host or pass resolved credentials outside the sandbox request.

Build with npm install and npm run build, then give the built package to a Worker using agent-eval-worker --plugin @example/eval-agent-sample together with sandbox and benchmark plugins.
