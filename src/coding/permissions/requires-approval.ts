/** 需要交互式审批的 tool 名称（除非在项目设置中允许）。 */
export const CODING_TOOLS_REQUIRING_APPROVAL: string[] = [
  "shell",
  "write_file",
  "str_replace",
  "apply_patch",
  "mkdir",
  "move_path",
];
