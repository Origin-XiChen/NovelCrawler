# 代码签名指南(消除「Windows 已保护你的电脑 / 未知发布者」)

> 本文回答两件事:**要花多少钱**、**怎么申请**。
> 价格为本仓库排查时(2026-10)从公开页面查到的数值,**下单前请以官网报价为准**;
> 证书类产品价格变动频繁,且国内代理商折扣差异很大。

---

## 1. 先说清楚:这个弹窗和"管理员权限"是两回事

| 弹窗 | 判定依据 | 能否靠改代码解决 |
|---|---|---|
| `Could not create temporary directory!` | 单文件 exe 启动时**往临时目录解压**的权限 | ✅ 已解决:改成 onedir 文件夹发布,启动零解压(见 `UI-ANALYSIS.md` 第 10 节) |
| `Windows 已保护你的电脑`(SmartScreen)/`未知发布者` | **数字签名**与签名信誉 | ❌ 只能签名;代码层面只能"让二进制看起来正常" |

已经做过的"让二进制看起来正常"的事(降低了被判可疑的概率,但**不能替代签名**):

* 补上完整版本信息(公司/产品/描述/版本/版权)——原来这些字段全是空的;
* 关闭 UPX 压缩——UPX 壳是杀软与 SmartScreen 的重要负面信号;
* `使用说明.txt` 里写明该提示的处理方式,并强调**不需要**管理员权限
  (以管理员运行不会让 SmartScreen 消失,反而多弹一次 UAC)。

## 2. 三条路线与价格

| 路线 | 价格(2026-10 查得) | 门槛 | 适合本项目吗 |
|---|---|---|---|
| **Azure Artifact Signing**(原名 Trusted Signing) | **$9.99/月起**(Basic);Premium 档更贵,面向高签名量/多证书场景 | 需要 Azure 订阅 + 账单账户类型为 **Individual**(个人身份验证会直接取账单账户的姓名/地址) | ✅ **最推荐**:个人可申请、按月付费、无需购买硬件 |
| **传统 OV 代码签名证书** | 约 **¥3,588/年**(GlobalSign)、**¥4,888/年**(DigiCert) | **需要企业/组织身份**做组织验证;个人一般拿不到 | ⚠️ 若你名下没有可验证的公司/组织,基本走不通 |
| **传统 EV 代码签名证书** | 约 **¥6,888/年** | 同样需要组织验证 + 通常要求硬件令牌 | ⚠️ 价格高、门槛高;但 EV 的 SmartScreen 信誉最"立竿见影" |
| **SignPath Foundation** | **免费**(面向开源项目) | 项目需开源且采用其认可的开源许可、代码托管公开 | ✅ 若仓库是公开的、许可为 GPL-3.0,值得先试申请 |

> 价格出处:Azure 起价 $9.99/月来自 Microsoft 官方社区公告;OV/EV 人民币报价来自
> 沃通(WoSign)公开价格与资讯页,属**代理商口径**,只作量级参考。

### 为什么 CA/B 规则让"自己签"行不通

自 2023 年起,代码签名私钥必须存放在 **FIPS 140-2 Level 2 及以上的硬件/云 HSM** 中。
所以"用自签名证书(`New-SelfSignedCertificate`)签一下"这类做法**没有任何用** ——
自签名的根不受信任,弹窗照旧。必须由受信任的 CA 签发。

## 3. 推荐路线:Azure Artifact Signing 申请步骤

1. **准备 Azure 订阅**:个人可以注册(需信用卡)。注意账单账户的
   **Account Type 必须是 Individual**,且**姓名/地址要与身份验证一致** ——
   服务会直接从这里取个人信息做个人身份验证。
2. 在 Azure 门户搜索 **Artifact Signing**,创建资源:
   - 选择区域(如 West Europe,或列出的受支持区域);
   - **Pricing tier 选 Basic**($9.99/月);
   - 记下账号名与区域。
3. 创建 **Identity validation**(身份验证):选 Public Trust → Individual,
   按提示提交信息。**这一步需要人工审核,通常要几天**,是整条链路最耗时的一步。
   - 若同一账号还要给"组织"签名,需另做一次 Organization 验证(需要能证明组织的材料)。
4. 创建 **Certificate profile**:类型选 Public Trust,关联上面的身份验证。
   之后就能拿到签名所需的证书。
5. 给执行签名的人/流水线分配 **Artifact Signing Certificate Profile Signer** 角色
   (标准 Azure RBAC 即可,**不需要** Entra ID P2 或 Governance 许可 —— 这点常被误解)。
6. 用 `signtool` 签名并**带时间戳**(时间戳免费,且证书过期后签名仍有效):

   ```bat
   signtool sign /v /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 ^
     /d "NovelCrawler NovelCrawler" ^
     /du "https://github.com/Origin-XiChen/NovelCrawler" ^
     dist\NovelCrawler\NovelCrawler.exe
   ```

   Azure 云签名有两种接法:
   * **signing integrations** / `TrustedSigning` dlib 方式:签名在云端完成,私钥不出云;
   * 或用 `signtool` 的 Azure 插件(`Azure.CodeSigning.Dlib.dll` + 一个 JSON 元数据文件)。

7. 验证:

   ```powershell
   Get-AuthenticodeSignature dist\NovelCrawler\NovelCrawler.exe | Format-List Status,SignerCertificate
   ```

   期望 `Status: Valid`,且签名者是你验证通过的主体名。

### 要签哪些文件

**onidir 形态下只需签 `NovelCrawler.exe`** —— SmartScreen 判定的是用户直接双击运行的那个
可执行文件。`_internal\` 里的 DLL/pyd 不参与该判定,不必逐个签(逐个签也会显著拖慢构建)。

## 4. 签名后的预期与时间线

* **EV 证书 / Azure Public Trust**:签名身份受 Microsoft 信任链背书,通常能较快摆脱
  "未知发布者";但 SmartScreen **信誉仍需要一个累积过程**(一段时间内下载量/运行量)。
  刚签完头几次下载仍可能弹窗,这属于正常现象,不是签名失败。
* **OV 证书**:起步时通常仍会弹,需要一段时间的"干净"下载与运行记录来攒信誉。
* 无论哪种,**签完后不要重新打包**(会破坏签名),也不要再打开 UPX(已在 spec 里关掉)。

## 5. 还没拿到证书时的临时缓解(都不需要动电脑设置)

* `使用说明.txt` 已写明:点「更多信息」→「仍要运行」;
* 用户侧「右键 → 属性 → 解除锁定」可去掉"来自 Internet"标记(这属于改电脑设置,不推荐作为主路径);
* 把 zip 上传到 GitHub Releases 属于"从网上下载",必然带 Mark-of-the-Web,所以**这条路只会让你更需要签名**;
* 若被 Defender 误报(与 SmartScreen 不同),可向 Microsoft 提交误报申诉。

## 6. 结论(给本项目的建议)

1. **先做便宜的**:$9.99/月的 Azure Artifact Signing(Basic)。个人可申请、
   无需硬件、按月可停;先跑通"能签出 Valid 的签名"。
2. **同时看免费选项**:若仓库公开且为 GPL-3.0,试试 SignPath Foundation。
3. **不要**买自签名或来路不明的"低价代签"证书:签名主体必须能对应到真实身份,
   否则一旦被滥用吊销,损失比省下的钱大得多。
4. 记住优先级:**先把"必须管理员"这类真实故障修掉(已完成),再谈签名** ——
   签名解决的是"观感与信任",不解决"跑不起来"。