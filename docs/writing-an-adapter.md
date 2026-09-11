# Bring CourseRaptor to Your University

[返回首页](../README.md) · [提交学校适配建议](https://github.com/Health-525/courseraptor/issues/new?template=university_adapter.yml)

> **状态：设计草案。** 当前正式支持仅限 NJTECH；Adapter 加载机制尚未发布。本文定义目标边界，避免在没有测试和维护承诺时把学校列为“兼容”。

CourseRaptor 的通用能力——对话、记忆、日历、文件处理和界面——不应依赖任何一所学校。学校差异应收敛在 Adapter：认证、课表、成绩、考试和通知。

## 目标接口

第一个可用 Adapter 不需要覆盖全部教务菜单。优先实现只读、学生高频且可测试的 3～5 个方法：登录、课表、成绩、考试，以及可选的通知。

```ts
interface UniversityAdapter {
  /** 学校的稳定标识，例如 "njtech"。 */
  readonly id: string;

  /** 仅建立会话；不得把凭证写进日志、异常或测试样例。 */
  login(): Promise<void>;

  getSchedule(): Promise<Schedule[]>;
  getGrades(): Promise<Grade[]>;
  getExams(): Promise<Exam[]>;
  getNotices?(): Promise<Notice[]>;
}
```

返回的数据将规范化为 CourseRaptor 的通用模型；不同学校的字段名、学期编码、节次和评分规则留在 Adapter 内部。写操作（例如选课提交）不属于第一版 Adapter 范围。

```text
CourseRaptor Agent
       │
UniversityAdapter
  ┌────┴─────┐
NJTECH     Your university
  ✅             🧩
```

## 在代码落地前，怎样参与

1. 用 [学校适配模板](https://github.com/Health-525/courseraptor/issues/new?template=university_adapter.yml) 提供学校、系统供应商（如已知）、你想解决的场景和**公开**资料链接。
2. 不要上传账号、密码、Cookie、完整成绩单、含个人信息的 HAR、或仅登录后才能访问的附件。
3. 如果你愿意开发，请先用虚构/脱敏响应写 fixture 和测试，再讨论接口实现。不要把校园线上系统当作测试环境高频请求。
4. 维护者确认边界、测试样例和维护人后，再创建该学校的 Adapter 目录与支持状态。

## 对 Adapter 作者的验收标准

- 每个请求有明确的超时、错误信息与限速，不把网络或认证失败伪装成“没有数据”。
- 课表至少覆盖学期、星期、节次、地点和单双周/部分周；缺字段时如实标记。
- 成绩规则（例如绩点、重修和通过判定）不能直接复用 NJTECH 假设，必须有独立测试。
- 测试只使用虚构或不可逆脱敏的 fixture；CI 不依赖真实学校服务。
- 文档说明适配范围、已知限制和维护人。只有满足这些条件才会显示为“已支持”。

## 当前状态

NJTECH 的现有实现还在 [`src/jwgl/`](../src/jwgl/) 中。下一步是从其中提取通用数据模型和 Adapter 注册表，保持现有 NJTECH 行为不变，再邀请第二所学校以只读能力验证这条边界。

这不是承诺任何学校都能接入。不同学校即使使用同一供应商，也常有不同的认证、字段和开放范围；先建立可靠的最小适配，再逐步扩展。
