# GIF Retarget Pipeline v1

这条管线把“换角色”与“复刻动作”分开处理。参考 GIF 是动作、表情、接触点、相位、特效和时序的唯一真值；角色图只控制人物身份、服装、配色和画风。

## 运动分类

每个任务必须先把像素分为四类，不能再用“人物固定/人物移动”的二分法：

1. `world_static`：画布、桌沿、键盘等世界锚点。
2. `reference_rigid_motion`：原 GIF 明确存在的头部或道具整体运动。
3. `reference_deformation`：手指、手腕、表情、发梢和特效的逐帧变化。
4. `appearance_invariant`：角色身份、服装、配色和线条风格。

非意图漂移定义为“输出运动减去按角色比例缩放后的参考运动”，不是“人物有没有移动”。

## 标准流程

1. `analyze_reference.py` 解码原 GIF，保存全部帧、时序、循环、哈希和编号接触表。
2. 人工填写 manifest 的逐帧语义合同和关键点轨迹。
3. 同时执行两条路线：
   - `rig`：分层母版，按参考轨迹机械驱动。
   - `frame_transfer`：每个原始帧单独作为动作参考，只替换角色身份。
4. `verify_job.py` 检查结构、速度倍率、透明、禁用颜色、世界锚点和轨迹合同。
5. 对两条路线做原图并排动画、洋葱皮、深浅背景和 120px 人工验收。
6. 只有通过语义门禁的路线才能写入 `selected`；失败路线必须保留并记录原因。

## 用法

```bash
python3 tools/gif-retarget-pipeline/analyze_reference.py \
  --gif assets/cat/cat-working-3.gif \
  --output artifacts/working-3-pipeline-v1/reference

python3 tools/gif-retarget-pipeline/verify_job.py \
  artifacts/working-3-pipeline-v1/manifest.json
```

## ImageGen 规则

- 使用 built-in ImageGen，一次生成一个资产或一个明确变体。
- 提示词必须标记每张输入图的角色：动作参考与角色参考不能混用。
- 每份提示词都必须写明禁止绿色、黄绿色、薄荷绿、青绿色及绿色边缘。
- ImageGen 没有返回 token 字段时，manifest 的 `token_usage` 必须为 `null`，同时记录调用次数；禁止编造 token 数。

## 门禁原则

- 生成了 12 张图，不等于复刻了 12 个动作相位。
- 不能用运动符号替代真正应该移动的手指。
- 不能通过锁死原作本来存在的头部运动来通过“防抖”检查。
- 逐帧生成路线必须先对齐世界锚点，再检查动作轨迹；禁止把脸部统一拉回中位数。
- 技术检查通过不能替代人工观看；接入桌宠后还要在真实透明桌面窗口验收。
