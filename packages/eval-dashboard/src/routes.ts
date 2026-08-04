export const ROUTES = [
  { path: '/', id: 'overview', label: 'Overview', eyebrow: 'System pulse' },
  { path: '/library', id: 'library', label: 'Test Library', eyebrow: 'Immutable inputs' },
  { path: '/runs', id: 'runs', label: 'Runs', eyebrow: 'Execution control' },
  { path: '/leaderboard', id: 'leaderboard', label: 'Leaderboard', eyebrow: 'Native ranking' },
  { path: '/analysis', id: 'analysis', label: 'Analysis', eyebrow: 'Trace intelligence' },
  { path: '/defects', id: 'defects', label: 'Defects', eyebrow: 'Failure evidence' },
  { path: '/regression', id: 'regression', label: 'Regression', eyebrow: 'Release gates' },
  { path: '/insights', id: 'insights', label: 'Insights', eyebrow: 'Product impact' },
  { path: '/reports', id: 'reports', label: 'Reports', eyebrow: 'Immutable exports' },
  { path: '/administration', id: 'administration', label: 'Administration', eyebrow: 'Policy & audit' },
] as const

export type RouteId = typeof ROUTES[number]['id']

export function routeFromPath(pathname: string): typeof ROUTES[number] {
  return ROUTES.find((route) => route.path === pathname) ?? ROUTES[0]
}
