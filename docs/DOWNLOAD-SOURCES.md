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

2026-10-29 09:22（北京）的手动补采快照新增了 PLOS Biology 论文 `10.1371/journal.pbio.3003778`，发表于2026-10-13。其[官方逐篇接口](https://counter.plos.org/api/v1.0/stats/doi/10.1371/journal.pbio.3003778/format/json)返回2026-10月份 `get-pdf = 265`，没有缺失PDF字段；独立只读复核与快照一致。这里的265次是原平台PDF请求数，不是独立读者、HTML访问或混合total；记录时间之后数值可以变化。这篇文献随后正常进入监控库，并非加入无关旧论文填榜。其余缺少原平台数据的论文仍保持未知。
