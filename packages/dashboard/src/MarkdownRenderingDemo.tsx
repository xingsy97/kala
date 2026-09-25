import { AssistantMarkdown } from './features/chat/ChatPanel.js'

const COMPLETE = `# 中文 Markdown 标题

- **香港可以接受：**QRT completed
- **ASCII accepted:**QRT completed

| 地区 | 状态 | 代码 |
| --- | --- | --- |
| 香港 | 可以接受 | QRT |`

const STREAMING = `## 正在生成

- **香港可以接受：**QRT streaming`

/** Deterministic responsive fixture for Chromium and packaged WebKitGTK parity checks. */
export function MarkdownRenderingDemo(): JSX.Element {
  return (
    <main className="min-h-screen bg-background p-4 text-foreground" data-testid="markdown-rendering-fixture">
      <div className="mx-auto grid max-w-5xl gap-6 md:grid-cols-2">
        <section aria-labelledby="completed-heading">
          <h1 id="completed-heading" className="mb-3 text-sm font-semibold">Completed</h1>
          <AssistantMarkdown text={COMPLETE} />
        </section>
        <section aria-labelledby="streaming-heading">
          <h1 id="streaming-heading" className="mb-3 text-sm font-semibold">Streaming</h1>
          <AssistantMarkdown text={STREAMING} streaming />
        </section>
      </div>
    </main>
  )
}
