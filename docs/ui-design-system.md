# Serendipity · 际遇 UI 设计系统

本规范由 Phase001 生产，服务中文个人旅行规划与管理后台。技术选择固定为 Tailwind CSS 4、shadcn/ui 和 lucide-react；本阶段只定义设计契约，组件、CSS 和页面在各自生产阶段实现。

## UI 风格定位

界面清晰、现代，适合重复使用的工具型产品。根页面第一屏直接提供自然语言旅行输入和提交体验，品牌展示名为 `Serendipity · 际遇`；不做营销式首页。页面分区采用完整横向区域或无框内容布局，不把整页模块装进浮动卡片，不在卡片内嵌卡片。

前台优先读取需求、进度和已校验结果；后台优先扫描数据、比较版本和执行明确操作。照片与地图在对应生产卡作为有用途的媒体出现，使用获授权的真实地点资源，保留出处及失败状态；不以装饰图、渐变圆球或背景占据工作空间。

## 颜色

| Token | 固定值 | 用途 |
|---|---|---|
| primary | `#047857` | 品牌主色、主要提交、选中指示；配白色文字 |
| primary-hover | `#065f46` | 主按钮 hover/pressed |
| secondary | `#0369a1` | 辅助链接与次级强调；配白色文字 |
| secondary-hover | `#075985` | 辅助动作 hover |
| success | `#15803d` | 成功文字/图标；浅底 `#f0fdf4` |
| warning | `#a16207` | 警告文字/图标；浅底 `#fefce8` |
| error | `#b91c1c` | 错误文字/图标；浅底 `#fef2f2` |
| info | `#0369a1` | 信息提示；浅底 `#f0f9ff` |
| background | `#fafafa` | 页面背景 |
| surface | `#ffffff` | 输入、表格、弹窗和重复项目背景 |
| text | `#18181b` | 正文 |
| text-muted | `#52525b` | 次级说明 |
| text-subtle | `#71717a` | 辅助时间与占位文本，限白色底 |
| border | `#e4e4e7` | 默认分隔线，输入轮廓另用 neutral-500 |
| focus | `#0369a1` | 可见键盘焦点环 |

中性色采用完整 zinc 梯度，不能把所有分区染成品牌同色：

| 等级 | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| neutral | #fafafa | #f4f4f5 | #e4e4e7 | #d4d4d8 | #a1a1aa | #71717a | #52525b | #3f3f46 | #27272a | #18181b | #09090b |

普通文字对比度至少4.5:1，大字号文字至少3:1，必要的控件边界和焦点至少3:1。正文、主按钮、语义状态用上述指定前景/背景组合；neutral-400 不用作可读正文。状态同时呈现图标/文字，不只依赖颜色。这里只定义浅色主题，后续主题变化须完整定义并重新验证全部组合。

## 字体与字号

sans 为 `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif`；mono 为 `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`，仅用于代码、公开版本号和已脱敏 token 指纹，不展示秘密 token。

| Token | 字号 | 行高 | 用途 |
|---|---|---|---|
| xs | 12px | 18px | 辅助时间、来源标签 |
| sm | 14px | 20px | 表格、控件、次级正文 |
| base | 16px | 24px | 旅行正文、输入 |
| lg | 18px | 28px | 紧凑小节标题 |
| xl | 20px | 28px | 区域标题 |
| 2xl | 24px | 32px | 页面标题 |
| 3xl | 30px | 36px | 宽屏顶级品牌标题，仅真实需要时使用 |
| 4xl | 36px | 40px | 独立展示用途，不用于卡片/侧栏/后台标题 |

正文400、重点500、标题600、Tabs选中600。`letter-spacing: 0`；字号不随 viewport width 缩放。长中文自动换行，长 URL/ID 用 overflow-wrap:anywhere；按钮标签不得被裁切，必要时改为纵向布局。移动端输入保持16px，避免浏览器自动放大。

## 间距、圆角、阴影与边框

Tailwind 默认间距比例：2=0.5rem、4=1rem、6=1.5rem、8=2rem、12=3rem、16=4rem；细节允许1=0.25rem，密集行操作间隔2。前台内容间隔6/8，后台间隔4，不通过过量留白制造装饰。

| 圆角 Token | 固定值 | 使用范围 |
|---|---|---|
| sm | 2px | 紧凑状态标记 |
| base | 4px | 内联工具 |
| md | 6px | 按钮、输入 |
| lg | 8px | 独立重复卡片 |
| xl | 12px | 弹窗 |
| 2xl | 16px | 预留设计 token，普通卡片不使用 |
| full | 9999px | 圆形图标按钮、头像；模式选择优先标准分段控件 |

阴影沿用 Tailwind CSS 4 默认值，项目逻辑 base 映射为小面积标准阴影，不引入新滤镜：

| 阴影 Token | CSS 值 |
|---|---|
| sm | `0 1px 2px 0 rgb(0 0 0 / 0.05)` |
| base | `0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)` |
| md | `0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)` |
| lg | `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)` |
| xl | `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)` |

这里的 sm 对应 Tailwind 4 `shadow-xs`，base 对应 `shadow-sm`，其余同名；实现时显式映射避免不同版本类名偏移。默认边框1px neutral-200；可交互输入轮廓用 neutral-500，错误用 error。键盘焦点为2px focus实线环+2px白色间隔，不能用阴影作为唯一焦点。

## 响应式断点与布局

sm=640px、md=768px、lg=1024px、xl=1280px，采用 mobile-first。小于640px为单列，页面水平内边距16px；640px起24px；1024px起32px。前台最大内容宽1200px，后台最大1440px；后台小屏保留关键列与明细入口，表格允许有明确边界的横向滚动，整个页面不能横向溢出。

工具栏、图标按钮、计数器和骨架占位使用固定尺寸/网格轨道与 min-width:0，loading、hover 与数字增长不得改变布局。列表按稳定 ID 定位；媒体预留 aspect-ratio；地图高度移动端280px、桌面400px。375/768/1920px为后续基本检查视口，同时覆盖320px和200%缩放的换行边界。

## 按钮

尺寸默认高40px、水平16px、圆角md；移动主要动作最小44px触控区域。纯工具操作使用 lucide-react 熟悉符号，如 Undo2/Redo2/Download/Search；不为熟悉工具额外堆叠文字胶囊。图标按钮视觉40×40px，触控命中至少44×44px，有 aria-label 和悬停/焦点 tooltip；清晰命令可用图标+文本。

| 状态 | 视觉与行为 |
|---|---|
| primary | primary底/白字，hover用primary-hover |
| secondary | secondary底/白字，hover用secondary-hover |
| outline | 白底、neutral-500边框、text文字，hover neutral-100 |
| ghost | 透明底、text文字，hover neutral-100，无占位边框跳动 |
| disabled | opacity 0.5、原生disabled、不触发提交或重复请求 |
| loading | 固定原尺寸，LoaderCircle spinner替换图标，aria-busy=true，阻止重复提交 |
| focus-visible | 统一焦点环；不因hover而移除 |

## 输入框

默认高40px、移动44px，textarea至少3行；label永久可见，placeholder不代替label。颜色选项用swatch，模式用分段控件，二元设置用checkbox/switch，数值用input/stepper/slider，有限选项用select/menu，不用任意文本按钮模拟这些控件。

| 状态 | 视觉与行为 |
|---|---|
| default | 白底、1px neutral-500边框、正文text |
| focus | focus环、光标可见，label不移动遮挡输入 |
| error | error红边框+下方错误文本，aria-invalid=true，aria-describedby绑定错误 |
| disabled | neutral-100底、opacity 0.5、disabled，保留值可辨 |
| read-only | 保留可读值与复制能力，不伪装成可编辑；readonly语义 |

## 卡片

仅用于独立重复项目，如历史旅行计划或单条公告。白底、圆角lg=8px、阴影sm、内边距4=1rem；页面摘要作为无框定义列表，避免卡片套卡片。卡片内标题18px以内，动作不与标题/文本重叠。

| 状态 | 视觉与行为 |
|---|---|
| default | 1px neutral-200边界、标准白底 |
| interactive | 只有整体确为单一链接时hover阴影base；焦点环可见，多动作时用独立语义按钮 |
| selected | primary边框与可读选中标记，布局尺寸保持不变 |
| loading | 与最终文本/媒体尺寸对应的骨架，aria-busy=true |

## Tabs

下划线样式，默认文字sm、底部neutral-200线；选中使用600字重与2px primary下划线。内容区域独立无框，禁止切换时重置未提交表单。

| 状态 | 视觉与行为 |
|---|---|
| inactive | text-muted，hover text，固定tab槽宽避免加粗抖动 |
| active | 加粗text+primary下划线，aria-selected=true |
| disabled | 降低透明度，不能选择 |
| keyboard-focus | 可见focus环，方向键/Home/End按Tabs语义移动焦点 |

## 表格

使用语义table、明确表头，表头sticky、背景surface，斑马纹使用surface/neutral-50；数值右对齐并用tabular-nums，正文左对齐，缺失数据明确显示“未知”。分页默认20行、可选20/50/100，有总数、当前页和前后页图标按钮，不展示秘密字段。

| 状态 | 视觉与行为 |
|---|---|
| normal | 固定列定义、sm字号；后台行高40px，必要长文本可增高而不裁切 |
| hover | neutral-100高亮整行，不隐去键盘动作 |
| selected | 浅primary背景+checkbox语义，批量操作仅在相应功能授权后出现 |
| loading | 固定行数骨架与稳定表头，局部刷新保留旧行并显示忙碌状态 |
| empty | 表头保留，一行跨列空状态，无虚假分页 |
| error | 跨列错误态与重试，保留有效筛选条件 |

## 弹窗

半透明黑色遮罩 `rgb(0 0 0 / 0.5)`，白色内容区、圆角xl、阴影lg，关闭X在右上角。宽度min(560px,100%-32px)，最大高85dvh，内部可滚动，标题20px，底部操作不遮正文。

| 状态 | 视觉与行为 |
|---|---|
| open | 对话框角色、标题关联、焦点进入并被约束；背景inert，关闭后焦点返回触发器 |
| submitting | aria-busy、保存按钮loading，防重复提交；不在保存完成前伪装成功 |
| error | 保留表单数据，错误文本与输入关联，焦点指向首个失败字段 |
| closed | 卸载/隐藏时不占焦点顺序；Escape与关闭按钮遵循可取消的产品状态 |

危险产品动作在对应卡实现明确确认；开发阶段的自动执行不能代替产品用户确认。无保存的只读弹窗可通过Escape/遮罩关闭，含未提交数据时按明确放弃动作处理。

## Toast

桌面右上角，宽度360px以内，移动端距左右16px和安全区顶部16px，最多同时3条。普通提示4秒自动消失，悬停/焦点暂停计时，有关闭按钮；必须由用户处理的错误保留内联提示，不让4秒消失成为唯一反馈。

| 状态 | 视觉与行为 |
|---|---|
| success | Check图标+success文字，role=status |
| error | CircleAlert图标+error文字；阻断错误用role=alert，避免重复播报 |
| info | Info图标+info文字，role=status |
| paused | 用户悬停/焦点期间保持显示，不更改布局宽度 |

## 加载态

| 状态 | 视觉与行为 |
|---|---|
| initial | 首次加载使用对应最终布局的骨架，预留标题、行和媒体空间，aria-busy=true |
| refreshing | 局部刷新保留已验证内容，局部spinner；只禁用与在途写入冲突的动作 |
| long-running | 规划展示服务端已确认进度与可用取消动作；不编造百分比或提前展示未校验JSON |
| reduced-motion | prefers-reduced-motion下停用闪烁/旋转动画，保留静态忙碌图标和可访问状态 |

## 空状态

| 状态 | 视觉与行为 |
|---|---|
| first-use | 相关lucide图标+短事实文本+明确命令，例如“创建第一个旅行计划” |
| filtered | Search图标+“无匹配记录”+清除筛选按钮，不引导重复创建 |
| optional-module | 标记“暂无可用天气”等真实缺失原因，不留空白占位卡；来源/风险语义仍保留 |

## 错误态

| 状态 | 视觉与行为 |
|---|---|
| recoverable | 错误图标+安全错误信息+重试按钮，保留输入/已保存版本；失败组件局部重试 |
| not-found | owner/share/public按统一404呈现“内容不可用”，不泄露存在性和内部拒绝原因 |
| validation | 字段旁文本与错误边框，必要时顶部错误摘要；不清空有效输入 |
| degraded | 地图/媒体/天气不可用时显示对应安全说明，文字行程仍完整，不假填事实 |

错误区不展示堆栈、密钥、系统Prompt或私人trace；支持复制的仅为安全requestId。可重试动作受幂等与当前权限约束，不进行无限自动重试。

## 旅行结果页模块展示规则

消费同一按access=owner/share/public投影并通过Schema的 `PlanViewModel`，按以下顺序组织完整区域，摘要语义可称摘要卡片但布局无装饰外框。公开投影和权限先于布局、地图视口及媒体请求计算。

| 模块 | 正常展示 | 缺失/降级/限制 |
|---|---|---|
| 摘要 | 目的地、日期/相对日、预算、人数、固定版本和质量状态的紧凑定义列表 | null显示未知/待核验；假设显式可见；版本与权限操作分开 |
| 每日时间轴 | 按稳定dayId分组，活动、住宿夜、交通与来源，可切换天数 | order_only保留顺序，时间为null，不显示虚构精确时刻；不以数组下标作身份 |
| 预算明细表 | 展示服务端knownSubtotal、币种、范围、单价/数量/金额和未知项 | 不在UI重算，不把unknown当0，不把估算显示为精确总价 |
| 地图 | Leaflet客户端懒加载，默认OpenStreetMap瓦片经SystemConfig map.provider注册开关/URL/attribution | 只用可信且可公开Place坐标计算视口；无合规坐标不请求瓦片，降级文字路线；私人坐标先过滤 |
| 天气 | 有forecast/seasonal数据时显示kind、来源及生成/当前freshness | unknown明确说明；缓存状态不能冒充事实新鲜度 |
| 风险 | 显示确定性level/status、来源、影响和行动 | 未获核验不伪装安全；blocking保持阻断含义 |
| 评分与质量 | 有评分时显示对应版本、评测口径与qualityReport | AI自评不作事实核验；needs_review/NEEDS_REVALIDATION醒目标识并禁用契约不允许的动作 |
| 来源与备选 | 安全SourceSummary和经过权限裁剪的备选文本 | 无安全URL为null；公开页面不包含可执行planPatch、聊天、内部trace与私人地点 |

当前版本和历史确认分开显示；clone目标为NEEDS_REVALIDATION，未重新核验不得finalize/分享/公开发布或当已核验版本导出。用户读取某个版本时不能静默跳转latest。

## 后台页面信息密度

后台标题24px以内，表格sm=14px、基础行高40px、紧凑筛选行与16px区域间距。优先展示标识、状态、revision、更新时间及明确操作；长JSON/Prompt通过受保护详情视图查看，不挤在主列表，不提供密钥明文读回。

筛选使用输入/select，视图用Tabs，启停用switch并显示保存状态，数字设置用合适数值控件；编辑、撤销、刷新用lucide图标与tooltip，危险动作有清晰命令和对应确认。loading/empty/error继承统一状态，sticky表头与工具条有固定层级，移动端折行后不遮挡第一行。

## 验证边界

本卡的自动检查验证token、十类组件各至少两种状态、文字/控件尺寸及模块规范齐全，并计算指定颜色组合对比度。真实浏览器、键盘焦点、DOM、axe、截图和媒体加载在对应UI生产卡执行，后续证据标记AUTOMATED_BROWSER_A11Y；真人读屏体验为NOT_EVALUATED。本规范不声称已经实现或认证了页面。
