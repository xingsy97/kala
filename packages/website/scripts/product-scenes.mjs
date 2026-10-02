// Product evidence contract: keep the first hero scene calm and contextual.
// Later scenes may focus attention on one advanced surface, but must still use
// the production Dashboard and fictional transport fixtures.
export const heroScenes = [
  {
    label: 'Workspace overview',
    title: 'One session, every moving part.',
    description: 'Conversation, tools, files, a Task Graph, delegated review, context, and controls in one production workspace.',
    asset: 'hero-workbench.webp',
    darkAsset: 'hero-workbench-dark.webp',
    mobileAsset: 'mobile-session.webp',
    mobileDarkAsset: 'mobile-session-dark.webp',
    alt: 'Kala Dashboard overview with a production tool run, completed delegated review, files, model controls, and Task Graph access.',
  },
  {
    label: 'Delegated execution',
    title: 'Parallel agents, one thread.',
    description: 'Running, completed, failed, cancelled, and pending work remains inspectable together.',
    asset: 'subagent-activity.webp',
    darkAsset: 'subagent-activity-dark.webp',
    alt: 'Kala Dashboard showing a production subagent lifecycle matrix.',
  },
  {
    label: 'Operator control',
    title: 'Decisions stay explicit.',
    description: 'A production workflow pauses at a durable operator-owned decision.',
    asset: 'ask-user-workflow.webp',
    darkAsset: 'ask-user-workflow-dark.webp',
    alt: 'Kala Dashboard showing production evidence and a durable operator decision.',
  },
]

// Responsive evidence uses the same production Dashboard at three breakpoints.
// Phone and tablet share one comparison scene; desktop remains separate.
export const responsiveScenes = [
  {
    label: 'Phone + Tablet',
    kind: 'device-pair',
    title: 'One session, two compact screens.',
    description: 'The same production session remains usable on phone and tablet.',
    phoneAsset: 'mobile-session.webp',
    phoneDarkAsset: 'mobile-session-dark.webp',
    tabletAsset: 'tablet-session.webp',
    tabletDarkAsset: 'tablet-session-dark.webp',
    alt: 'Kala mobile and tablet Dashboards shown together in accurate device frames.',
  },
  {
    label: 'Desktop',
    title: 'The full operating picture.',
    description: 'Session navigation, delegated work, files, and controls share one inspectable workspace.',
    asset: 'subagent-activity.webp',
    darkAsset: 'subagent-activity-dark.webp',
    alt: 'Kala desktop Dashboard showing subagent activity, files, session navigation, and Composer controls.',
  },
]
