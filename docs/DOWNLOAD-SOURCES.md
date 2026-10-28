# 逐篇下载量来源核验 · 2026-10-29

## PLOS：公开PDF请求月计数

PLOS自己的[指标组件脚本](https://journals.plos.org/resource/js/components/metrics_viewed_section.js)使用公开接口：

```text
https://counter.plos.org/api/v1.0/stats/doi/{DOI}/format/json
```

响应按月份返回使用事件，PDF下载对应 `get-pdf`。根 `total` 混合多种使用事件，不能当下载次数；HTML、XML请求同样不能替代PDF。

只读实测 DOI `10.1371/journal.pone.0170929` 成功，116个明确返回月份的PDF请求合计4249。该旧论文仅用于接口验证，没有添加到当前领域文献库。指标是PDF请求数，不是独立读者，最近数据可能延迟48小时。详见 [PLOS使用统计说明](https://journals.plos.org/ploscompbiol/s/usage-data-help)。

代码验证合法0、缺字段、损坏月份、重复PDF行和异常数值。部分月份缺PDF字段时保留覆盖说明，不把缺失推定成0，不参与完整累计排行。不同平台、下载类型和窗口分别排名。

## 其他来源与限制

- Zenodo：仅原论文自身 DOI 和 publication 类型匹配时读取官方文件下载统计；关联数据集不代替论文下载。
- PMC：逐篇使用报告需要出版社权限，公共API不能直接覆盖。[官方说明](https://pmc.ncbi.nlm.nih.gov/about/faq/)
- bioRxiv：公开 usage 接口是平台汇总，不能作为逐篇数据。[官方API](https://api.biorxiv.org/)
- PeerJ、bioRxiv的部分官方页面在核查时返回403/429，未绕过限制，未据此编造接口或计数。

当前库130篇尚无PLOS或Zenodo原论文DOI匹配，因此榜单没有可显示的真实计数。后续原始文献进入采集范围时会自动适配，也可以导入有授权的出版社统计。
