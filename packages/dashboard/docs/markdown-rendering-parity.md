# Markdown rendering parity fixture

Run the Dashboard in development, or build it with `VITE_VISUAL_TEST_FIXTURES=1`, then open `?demo=markdown-rendering` at mobile and desktop viewport widths. Production builds do not expose the fixture unless that explicit build flag is set. The deterministic fixture covers completed and streaming Chinese emphasis, headings, and an overflowing semantic table. It uses `AssistantMarkdown`, the same component and CSS served to web browsers and the Desktop webview; there is no engine-specific Markdown style path.

Automated semantic coverage lives in `src/MarkdownRenderingDemo.test.tsx` and the chat Markdown tests. The packaged WebKitGTK runtime is not available in the unit-test environment, so final pixel comparison in that engine remains a release/manual check. The fixture makes that comparison deterministic and verifies the DOM contract in CI.
