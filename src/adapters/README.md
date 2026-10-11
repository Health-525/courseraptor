# 学校适配器（插件式）

本目录是 CourseRaptor 的**学校适配器装配点**。内核（`src/core`）只依赖
`src/core/school.ts` 定义的 `SchoolAdapter` 端口，不认识任何具体学校；每所学校
是一个可插拔的适配器。

## 目录约定

```
src/adapters/
├── index.ts      # 装配点：扫描本目录、动态发现并登记插件（随仓库分发）
├── custom/       # 内置适配器：「不接入任何学校」的手动课表兜底（随仓库分发）
├── README.md     # 本文件
└── njtech/       # 南京工业大学插件（本地私有，不入库 —— 见下）
```

`index.ts` 启动时会 `readdirSync` 扫描本目录下除内置目录（`custom`）外的所有
子目录，用计算式动态 `import()` 逐个加载，把导出的 `SchoolAdapter` 登记进
`core/school` 的选项表。因此**新增一所学校无需改装配点**：建一个目录、导出一个
`SchoolAdapter` 形状的对象即可被自动发现。

登记顺序＝网页设置页「学校」下拉的顺序：真实学校插件在前，`custom`（其他学校）垫底。

## 真实学校适配器是本地插件（默认不入库）

针对某一所真实学校的适配器（如 `njtech/`）含该校教务协议、域名、校历与账号逻辑，
属于**本地私有插件**，通过 `.gitignore` 排除、不进公开仓库：

- 公开仓库 / CI 上没有真实学校代码时，装配点只登记内置 `custom`，编译与测试照常通过；
- 依赖真实学校的测试用 `tests/_util/njtech-probe.ts` 的 `HAS_NJTECH` 降级为跳过；
- 本地把插件目录放回 `src/adapters/<学校>/` 即被自动加载，无需任何注册代码改动。

配套的无头查询技能包 `skills/njtech-jwgl/` 同样属于该插件、一并不入库。

## 写一个新学校插件

1. 在 `src/adapters/` 下建目录，如 `src/adapters/foo/`；
2. 实现并导出一个 `SchoolAdapter`（见 `src/core/school.ts` 的端口定义：`info`、
   `capabilities`、`terms`、`auth`、可选的 `schedule`/`notices`、`tools`、
   `promptSections()`）。导出名不限，装配点按形状识别；
3. 无需改 `index.ts`——重启即被扫描登记，网页设置页「学校」栏可选；
4. 如需本地私有，把目录名加进 `.gitignore`。

调试逃生舱：`RAPTOR_SCHOOL=<id>` 强制指定启动学校（优先级高于凭证里保存的
`schoolId`，二者都缺时回落 `custom`）。
