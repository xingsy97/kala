export const ROUTES = [
  { path: '/', id: 'overview', label: 'Overview', eyebrow: 'Quality and readiness' },
  { path: '/library', id: 'library', label: 'Test Library', eyebrow: 'Datasets and task sets' },
  { path: '/runs', id: 'runs', label: 'Runs', eyebrow: 'Create and monitor' },
  { path: '/leaderboard', id: 'leaderboard', label: 'Leaderboard', eyebrow: 'Compare systems' },
  { path: '/analysis', id: 'analysis', label: 'Analysis', eyebrow: 'Scores and patterns' },
  { path: '/defects', id: 'defects', label: 'Defects', eyebrow: 'Review verified issues' },
  { path: '/regression', id: 'regression', label: 'Regression', eyebrow: 'Validate releases' },
  { path: '/insights', id: 'insights', label: 'Insights', eyebrow: 'Prioritized actions' },
  { path: '/reports', id: 'reports', label: 'Reports', eyebrow: 'Create and share' },
  { path: '/administration', id: 'administration', label: 'Administration', eyebrow: 'Access and operations' },
] as const

export type RouteId = typeof ROUTES[number]['id']

export function routeFromPath(pathname: string): typeof ROUTES[number] {
  return ROUTES.find((route) => route.path === pathname) ?? ROUTES[0]
}
