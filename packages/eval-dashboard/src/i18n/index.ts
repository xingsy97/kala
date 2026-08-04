export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const
export type Locale = typeof SUPPORTED_LOCALES[number]

const messages = {
  en: {
    'app.skip': 'Skip to content', 'app.brand': 'Agent Evaluation', 'app.controlPlane': 'local control plane',
    'app.refresh': 'Refresh', 'app.awaiting': 'Awaiting state', 'app.updated': 'Updated {time}', 'app.locale': 'Language',
    'locale.en': 'English', 'locale.zh-CN': '简体中文', 'connection.controlPlane': 'Control Plane', 'connection.offline': 'Offline', 'connection.stale': 'Stale data', 'connection.reconnecting': 'Reconnecting',
    'state.loading': 'Loading', 'state.ready': 'Ready', 'state.empty': 'Empty', 'state.partial': 'Partial data', 'state.stale': 'Stale data', 'state.error': 'Error', 'state.offline': 'Offline', 'state.unsupported': 'Capability unavailable',
    'route.overview': 'Overview', 'route.library': 'Test Library', 'route.runs': 'Runs', 'route.leaderboard': 'Leaderboard', 'route.analysis': 'Analysis', 'route.defects': 'Defects', 'route.regression': 'Regression', 'route.insights': 'Insights', 'route.reports': 'Reports', 'route.administration': 'Administration',
    'eyebrow.overview': 'System pulse', 'eyebrow.library': 'Immutable inputs', 'eyebrow.runs': 'Execution control', 'eyebrow.leaderboard': 'Native ranking', 'eyebrow.analysis': 'Trace intelligence', 'eyebrow.defects': 'Failure evidence', 'eyebrow.regression': 'Release gates', 'eyebrow.insights': 'Product impact', 'eyebrow.reports': 'Immutable exports', 'eyebrow.administration': 'Policy & audit',
    'admin.workers': 'Workers', 'admin.agents': 'Agents', 'admin.sandboxes': 'Sandboxes', 'admin.datasets': 'Datasets', 'admin.auditRecords': 'Audit records',
    'admin.authTitle': 'Auth principals & service keys', 'admin.authEyebrow': 'Metadata only — no token material', 'admin.trustTitle': 'Trust key registry', 'admin.trustEyebrow': 'Public key material redacted',
    'admin.reloadPrompt': 'Type to reload', 'admin.reloadLabel': 'Security reload confirmation', 'admin.reloadAction': 'Reload security registry', 'admin.reloadSuccess': 'Security registry reloaded.',
    'admin.retentionStatus': 'Retention sweep status', 'admin.maintenance': 'Online maintenance authority', 'admin.backupTitle': 'Backup & restore drills', 'admin.backupEyebrow': 'Recovery objectives and audited drills',
    'admin.agentRegistry': 'Agent & credential-reference registry', 'admin.noCredentials': 'No plaintext credentials', 'admin.workerRegistry': 'Worker & sandbox capability registry', 'admin.capacity': 'Negotiated execution capacity',
    'admin.datasetCatalog': 'Dataset/version/subset catalog', 'admin.provenance': 'Immutable provenance', 'admin.verifierVersions': 'Verifier & detector versions', 'admin.analysisAuthority': 'Analysis authority',
    'admin.protocolPolicy': 'Protocol & local safety policy', 'admin.compatibility': 'Compatibility', 'admin.cleanCutover': 'Clean cutover', 'admin.enforced': 'enforced', 'admin.unavailable': 'unavailable', 'admin.legacy': 'Legacy surfaces', 'admin.destructive': 'Destructive actions', 'admin.exactConfirmation': 'exact confirmation + impact hash',
    'admin.governanceTitle': 'Retention & artifact policy', 'admin.governanceEyebrow': 'Transitive governance', 'admin.auditTitle': 'Immutable operation & publication audit', 'admin.committedOperations': 'Committed operations', 'admin.journalTip': 'Trusted journal tip', 'admin.verifiedQuery': 'Verified query', 'admin.trusted': 'trusted',
  },
  'zh-CN': {
    'app.skip': '跳到主要内容', 'app.brand': '智能体评测', 'app.controlPlane': '本地控制面',
    'app.refresh': '刷新', 'app.awaiting': '等待状态', 'app.updated': '更新于 {time}', 'app.locale': '语言',
    'locale.en': 'English', 'locale.zh-CN': '简体中文', 'connection.controlPlane': '控制面', 'connection.offline': '离线', 'connection.stale': '数据已过期', 'connection.reconnecting': '正在重连',
    'state.loading': '加载中', 'state.ready': '就绪', 'state.empty': '暂无数据', 'state.partial': '部分数据', 'state.stale': '数据已过期', 'state.error': '错误', 'state.offline': '离线', 'state.unsupported': '能力不可用',
    'route.overview': '概览', 'route.library': '测试库', 'route.runs': '运行', 'route.leaderboard': '排行榜', 'route.analysis': '分析', 'route.defects': '缺陷', 'route.regression': '回归', 'route.insights': '洞察', 'route.reports': '报告', 'route.administration': '管理与审计',
    'eyebrow.overview': '系统状态', 'eyebrow.library': '不可变输入', 'eyebrow.runs': '执行控制', 'eyebrow.leaderboard': '原生指标排名', 'eyebrow.analysis': '轨迹分析', 'eyebrow.defects': '失败证据', 'eyebrow.regression': '发布门禁', 'eyebrow.insights': '产品影响', 'eyebrow.reports': '不可变导出', 'eyebrow.administration': '策略与审计',
    'admin.workers': '工作节点', 'admin.agents': '智能体', 'admin.sandboxes': '沙箱', 'admin.datasets': '数据集', 'admin.auditRecords': '审计记录',
    'admin.authTitle': '认证主体与服务密钥', 'admin.authEyebrow': '仅显示元数据，不含令牌材料', 'admin.trustTitle': '信任密钥注册表', 'admin.trustEyebrow': '公钥材料已脱敏',
    'admin.reloadPrompt': '输入以下内容以重新加载', 'admin.reloadLabel': '安全注册表重新加载确认', 'admin.reloadAction': '重新加载安全注册表', 'admin.reloadSuccess': '安全注册表已重新加载。',
    'admin.retentionStatus': '保留策略清理状态', 'admin.maintenance': '在线维护权威状态', 'admin.backupTitle': '备份与恢复演练', 'admin.backupEyebrow': '恢复目标与已审计演练',
    'admin.agentRegistry': '智能体与凭据引用注册表', 'admin.noCredentials': '不含明文凭据', 'admin.workerRegistry': '工作节点与沙箱能力注册表', 'admin.capacity': '协商后的执行容量',
    'admin.datasetCatalog': '数据集/版本/子集目录', 'admin.provenance': '不可变来源', 'admin.verifierVersions': '验证器与检测器版本', 'admin.analysisAuthority': '分析权威状态',
    'admin.protocolPolicy': '协议与本地安全策略', 'admin.compatibility': '兼容性', 'admin.cleanCutover': '完全切换', 'admin.enforced': '已强制执行', 'admin.unavailable': '不可用', 'admin.legacy': '旧版接口', 'admin.destructive': '破坏性操作', 'admin.exactConfirmation': '精确确认 + 影响哈希',
    'admin.governanceTitle': '保留与制品策略', 'admin.governanceEyebrow': '传递性治理', 'admin.auditTitle': '不可变操作与发布审计', 'admin.committedOperations': '已提交操作', 'admin.journalTip': '可信日志末端', 'admin.verifiedQuery': '已验证查询', 'admin.trusted': '可信',
  },
} as const

export type MessageKey = keyof typeof messages.en

export function initialLocale(): Locale {
  const configured = new URLSearchParams(globalThis.location?.search ?? '').get('locale') ?? globalThis.localStorage?.getItem('agent-eval-locale') ?? globalThis.navigator?.language
  return configured?.toLocaleLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export function translate(locale: Locale, key: MessageKey, variables: Record<string, string> = {}): string {
  let output: string = messages[locale][key] ?? messages.en[key]
  for (const [name, value] of Object.entries(variables)) output = output.replaceAll('{' + name + '}', value)
  return output
}
