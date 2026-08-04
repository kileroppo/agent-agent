# ComfyUI API 工作流

这里不附带未经台式机验证的伪 API 工作流。ComfyUI 官方当前提供以下 MIT 许可界面模板：

- 文生图：`https://raw.githubusercontent.com/Comfy-Org/workflow_templates/refs/heads/main/templates/image_flux2_klein_text_to_image.json`
- 4B Distilled 编辑：`https://raw.githubusercontent.com/Comfy-Org/workflow_templates/refs/heads/main/templates/image_flux2_klein_image_edit_4b_distilled.json`

请在目标 4070 Ti Super 的真实 ComfyUI 中从官方模板加载并完成一次生成/编辑，再用 `Save (API Format)` 导出；普通界面工作流 JSON 含 subgraph 和前端状态，不能直接用于 `/prompt`，因此不能在没有目标 ComfyUI 的情况下冒充已生成可执行 API workflow。

必须保留以下占位符：

- 通用：`{{PROMPT}}`、`{{NEGATIVE_PROMPT}}`、`{{WIDTH}}`、`{{HEIGHT}}`、`{{STEPS}}`、`{{SEED}}`
- 编辑输入：`{{INPUT_IMAGE_0}}`，多参考图继续使用 `{{INPUT_IMAGE_1}}` 至 `{{INPUT_IMAGE_3}}`

节点健康检查会同时验证工作流文件存在、ComfyUI `/system_stats` 可访问，并能看到 NVIDIA/CUDA；只有文件存在不能标记 healthy。
