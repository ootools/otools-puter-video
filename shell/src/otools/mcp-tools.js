/**
 * Video Studio 的 MCP 工具总表。
 * ------------------------------------------------------------------
 * 桥（`mcp.js`）只负责把 `window.__otoolsMcp` 交给宿主；工具按用途分在三个文件里：
 *
 *   - `mcp-project-tools.js`  工程库：列/看/建/改名/打开（不依赖编辑器）
 *   - `mcp-editor-tools.js`   时间线：状态、目录、命令、加/改/删/切片段、转场、特效、轨道、设置
 *   - `mcp-media-tools.js`    素材与出片：import_media、export_video、export_frame、任务查询
 *
 * 这里只做拼装，让入口保持一行：`installMcpBridge({ extraTools: videoMcpTools() })`。
 * 共享的「活上下文」与单位换算在 `mcp-context.js`。
 */

import { setVideoMcpContext } from './mcp-context.js';
import { projectMcpTools } from './mcp-project-tools.js';
import { editorMcpTools } from './mcp-editor-tools.js';
import { mediaMcpTools } from './mcp-media-tools.js';
import { audioMcpTools } from './mcp-audio-tools.js';

export { setVideoMcpContext };

/** 全部领域工具（不含 `mcp.js` 的四个库文件工具）。 */
export function videoMcpTools() {
  return [...projectMcpTools(), ...editorMcpTools(), ...mediaMcpTools(), ...audioMcpTools()];
}
