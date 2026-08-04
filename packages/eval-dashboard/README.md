# @agent-kernel/eval-dashboard

Standalone evaluation Web application. It is an HTTP/SSE client of eval-orchestrator and never imports or scans Agent RunLab Host artifacts.

Routes: Overview, Test Library, Runs, Leaderboard, Analysis, Defects, Regression, Insights, Reports, and Administration/Audit.

Deployments may inject short-lived browser credentials without browser storage:

```html
<script>
  globalThis.__AGENT_EVAL_DASHBOARD__ = {
    controlPlaneUrl: "https://eval.example.test",
    controlPlaneAllowedOrigins: ["https://eval.example.test"],
    credentialProvider: { getToken: () => deploymentSession.getAccessToken() }
  };
</script>
```

The Control Plane must be same-origin or have its exact origin in `controlPlaneAllowedOrigins`. Tokens are resolved by the SDK for each request and are never read from or written to `localStorage`.
