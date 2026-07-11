# Past Mistakes
  
  This note records implementation mistakes that should not be repeated.
  
  - Do not move runtime policy into the kernel reducer.
  - Do not persist large duplicated LLM request bodies in every event-log entry.
  - Do not hide debugging data behind friendly summaries when the inspector is meant to teach the reducer loop.
  - Do not add UI animation to high-frequency scan surfaces.
  - Do not add compatibility layers for old experimental logs unless there is an active need.
  