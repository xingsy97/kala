# Chat Panel UX Design
  
  This document records the main chat-panel design decisions so future work does not rely on reconstructing intent from commit history.
  
  ## 1. Streaming Smoothness
  
  The old implementation appended every `text_delta` directly to React state. At high token rates that caused frequent `ChatPanel` rerenders and repeated markdown parsing for historical assistant messages.
  
  The current design batches deltas with `requestAnimationFrame`, drains the buffer adaptively, and memoizes `AssistantMarkdown`. Small backlogs render smoothly while large backlogs catch up without falling permanently behind. All streaming resets should go through the shared reset path so buffered text cannot leak into a later turn.
  
  ## 2. Auto-Scroll to Bottom
  
  Users reading earlier history should not be forced to the bottom by new messages. If they are already near the bottom, new content should follow automatically. The pinned state starts true, turns false when the user scrolls away from the bottom, and turns true again when the user returns close to the bottom.
  
  ## 3. Composer and Approval Flip
  
  Approval handling is integrated into the composer area as a 3D flip surface. The front is the normal composer and the back is the approval card. This keeps the decision point where the user's attention already is and avoids stacking banners above the input.
  
  The flip uses CSS perspective, `transform-style: preserve-3d`, backface hiding, measured height transitions, and `inert` on the hidden face so keyboard focus does not enter invisible content. Multiple pending approvals use one card with previous/next navigation and bulk approve/reject actions.
  
  ## 4. Tasks Button
  
  `todowrite` is a normal executor tool. The kernel does not contain a special todo state. The dashboard derives the latest task list from successful `todowrite` tool calls in the timeline.
  
  The composer utility area shows a compact Tasks button only when tasks exist. Clicking opens a temporary popover with the current task list. The popover does not push the transcript layout and does not provide direct editing, because the next agent `todowrite` call is the source of truth.
  
  ## 5. Image Content Preview
  
  Image content may come from pasted base64 data or workspace file references. The chat panel only displays content already present in the transcript. Thumbnails must fit within the message column, avoid hard borders, and signal clickability with cursor and hover affordances. Clicking opens a dialog-constrained larger preview.
  