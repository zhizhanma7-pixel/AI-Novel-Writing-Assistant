import type { MouseEvent } from "react";
import { Button } from "@/components/ui/button";

/**
 * 写法卡片上与写法包（Skill）相关的两个动作：停用/恢复自动命中、导出写法包。
 *
 * 单独拆出来是因为落地页有行数上限的契约（见
 * `tests/assetLibraryDesignContracts.test.js`），列表本身要保持紧凑。
 */
interface SkillPackageProfileActionsProps {
  profileId: string;
  /** 声明了哪些环节会自动命中；为空表示这条写法只能手动绑，开关就没有意义。 */
  applicableTasks: string[];
  autoMatchEnabled: boolean;
  autoMatchPending: boolean;
  exportPending: boolean;
  onToggleAutoMatch: (profileId: string, enabled: boolean) => void;
  onExportProfile: (profileId: string) => void;
}

export default function SkillPackageProfileActions(props: SkillPackageProfileActionsProps) {
  const {
    profileId,
    applicableTasks,
    autoMatchEnabled,
    autoMatchPending,
    exportPending,
    onToggleAutoMatch,
    onExportProfile,
  } = props;

  // 卡片整体可点选，动作按钮不能顺带把卡片也选中。
  const stop = (event: MouseEvent, run: () => void) => {
    event.stopPropagation();
    run();
  };

  return (
    <>
      {applicableTasks.length > 0 ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={autoMatchPending}
          onClick={(event) => stop(event, () => onToggleAutoMatch(profileId, !autoMatchEnabled))}
        >
          {autoMatchEnabled ? "停用自动命中" : "恢复自动命中"}
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={exportPending}
        onClick={(event) => stop(event, () => onExportProfile(profileId))}
      >
        {exportPending ? "导出中..." : "导出写法包"}
      </Button>
    </>
  );
}
