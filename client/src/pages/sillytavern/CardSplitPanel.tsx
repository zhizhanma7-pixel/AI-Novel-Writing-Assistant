import { useMemo, useState } from "react";
import type {
  SillyTavernCardSplitPlan,
  SillyTavernSegmentDestination,
} from "@ai-novel/shared/types/sillytavernCardSplit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DESTINATION_OPTIONS } from "./importCopy";

/**
 * 角色卡分流面板。
 *
 * 卡片在格式上像"一个角色"，但作者常把世界设定写在 `description` / `scenario`
 * 里。这个面板要让作者看清每一段将去哪，尤其是那些标着「需要你确认」的段落——
 * 它们不选就不给导入。
 */
export default function CardSplitPanel(props: {
  plan: SillyTavernCardSplitPlan;
  novels: { id: string; title: string }[];
  isImporting: boolean;
  onImport: (input: {
    decisions: { segmentId: string; destination: SillyTavernSegmentDestination }[];
    novelId?: string;
    characterName?: string;
  }) => void;
}) {
  const [choices, setChoices] = useState<Record<string, SillyTavernSegmentDestination>>(() => (
    Object.fromEntries(
      props.plan.segments
        // 归属明确的段落预填建议值；需要确认的留空，逼作者自己看一眼。
        .filter((segment) => segment.origin === "deterministic")
        .map((segment) => [segment.id, segment.suggestedDestination]),
    )
  ));
  const [novelId, setNovelId] = useState("");
  const [characterName, setCharacterName] = useState(props.plan.cardName);

  const destinationOf = (segmentId: string): SillyTavernSegmentDestination | undefined => (
    choices[segmentId]
  );

  const undecided = props.plan.segments.filter((segment) => !destinationOf(segment.id));
  const goesToCharacter = props.plan.segments.some(
    (segment) => destinationOf(segment.id) === "character",
  );
  const canImport = undecided.length === 0 && (!goesToCharacter || Boolean(novelId));

  const counts = useMemo(() => {
    const tally: Record<string, number> = { world: 0, character: 0, style: 0, skip: 0 };
    for (const segment of props.plan.segments) {
      const destination = destinationOf(segment.id);
      if (destination) {
        tally[destination] += 1;
      }
    }
    return tally;
  }, [choices, props.plan.segments]);

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-medium text-foreground">{props.plan.cardName}</div>
          <Badge variant="outline">{props.plan.segments.length} 段内容</Badge>
          {props.plan.needsReviewCount > 0 ? (
            <Badge variant="destructive">{props.plan.needsReviewCount} 段需要你确认</Badge>
          ) : null}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          这张卡里的内容不一定都属于这个角色。世界设定放进角色，会让它只在这个角色身上生效；
          反过来，角色自己的事写成世界设定，就会对所有角色成立。
        </p>
      </section>

      {props.plan.ignoredFields.length > 0 ? (
        <section className="rounded-xl border border-border/70 bg-muted/10 p-3">
          <div className="text-sm font-medium text-foreground">这些内容不会被导入</div>
          <ul className="mt-1 space-y-1 text-xs leading-5 text-muted-foreground">
            {props.plan.ignoredFields.map((entry) => (
              <li key={entry.field}>{entry.label} — {entry.reason}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {props.plan.embeddedBook ? (
        <section className="rounded-xl border border-primary/20 bg-primary/5 p-3">
          <div className="text-sm font-medium text-foreground">这张卡自带世界书</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            共 {props.plan.embeddedBook.includedCount} 条设定，会随「世界设定」一起导入。
            {props.plan.embeddedBook.excludedCount > 0
              ? ` 另有 ${props.plan.embeddedBook.excludedCount} 条在原文件里已关闭，不会导入。`
              : ""}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        {props.plan.segments.map((segment) => {
          const chosen = destinationOf(segment.id);
          const needsReview = segment.origin === "needs_review";
          return (
            <article
              key={segment.id}
              className={`space-y-2 rounded-xl border p-3 ${
                needsReview && !chosen ? "border-destructive/40 bg-destructive/5" : "border-border/70 bg-background"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground">{segment.sourceLabel}</div>
                {needsReview ? <Badge variant="destructive">需要你确认</Badge> : null}
              </div>
              <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                {segment.text}
              </p>
              <div className="text-xs leading-5 text-muted-foreground">{segment.reason}</div>
              <Select
                value={chosen ?? "choose"}
                onValueChange={(value) => setChoices((current) => ({
                  ...current,
                  [segment.id]: value as SillyTavernSegmentDestination,
                }))}
              >
                <SelectTrigger aria-label={`${segment.sourceLabel} 的去向`}>
                  <SelectValue placeholder="选择这段内容的去向" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="choose" disabled>选择这段内容的去向</SelectItem>
                  {DESTINATION_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label} — {option.hint}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </article>
          );
        })}
      </section>

      {goesToCharacter ? (
        <section className="space-y-3 rounded-xl border border-border/70 bg-muted/10 p-3">
          <div>
            <div className="text-sm font-medium text-foreground">这个角色属于哪本书</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              角色必须归属一本书；世界设定和文风是全局的，不需要选。
            </div>
          </div>
          <Select value={novelId || "choose"} onValueChange={(value) => setNovelId(value === "choose" ? "" : value)}>
            <SelectTrigger aria-label="目标作品">
              <SelectValue placeholder="选择一本书" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="choose">请选择一本书</SelectItem>
              {props.novels.map((novel) => (
                <SelectItem key={novel.id} value={novel.id}>{novel.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="st-character-name">角色名</label>
            <Input
              id="st-character-name"
              value={characterName}
              onChange={(event) => setCharacterName(event.target.value)}
            />
          </div>
        </section>
      ) : null}

      <section className="space-y-2 border-t border-border/70 pt-4">
        <div className="text-xs leading-5 text-muted-foreground">
          将导入：世界设定 {counts.world} 段 · 这个角色 {counts.character} 段 ·
          文风 {counts.style} 段 · 不导入 {counts.skip} 段
        </div>
        <Button
          type="button"
          disabled={!canImport || props.isImporting}
          onClick={() => props.onImport({
            decisions: props.plan.segments.map((segment) => ({
              segmentId: segment.id,
              destination: choices[segment.id],
            })),
            novelId: goesToCharacter ? novelId : undefined,
            characterName: characterName.trim() || undefined,
          })}
        >
          {props.isImporting ? "导入中…" : "按以上去向导入"}
        </Button>
        {undecided.length > 0 ? (
          <div className="text-xs leading-5 text-destructive">
            还有 {undecided.length} 段没有选择去向。
          </div>
        ) : null}
        {goesToCharacter && !novelId ? (
          <div className="text-xs leading-5 text-destructive">请选择这个角色属于哪本书。</div>
        ) : null}
      </section>
    </div>
  );
}
