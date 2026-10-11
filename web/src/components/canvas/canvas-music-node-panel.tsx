import { useState } from "react";
import { Button, Input, InputNumber, Modal, Popover, Segmented, Tooltip } from "antd";
import { ArrowUp, Download, FileText, LoaderCircle, Music4, RefreshCw, Settings2, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MUSIC_MODEL, type MusicCreationMode, type MusicFormat, type MusicGenerationDraft, type MusicOutputType, type MusicPlanningMode } from "@/constant/music";
import { canvasThemes } from "@/lib/canvas-theme";
import { hasResumableMusicTask, readMusicDraft, readMusicReferenceAnalysis, selectMusicReference } from "@/lib/canvas/canvas-generation-helpers";
import { getGroupResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { isMusicReferenceNode } from "./canvas-node-generation";

export function CanvasMusicNodePanel({ node, nodes, connectedLyrics, connectedNodes, isRunning, onConfigChange, onGenerate, onQuery, onResubmit, onStop, onDownloadScore, onAnalyze, onRearrange, onExportText, onDisconnect, onStartSelection }: {
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    connectedLyrics: string;
    connectedNodes: CanvasNodeData[];
    isRunning: boolean;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    onQuery: (nodeId: string) => void;
    onResubmit: (nodeId: string) => void;
    onStop: (nodeId: string) => void;
    onDownloadScore: (nodeId: string, variant?: "used" | "source") => void;
    onAnalyze: (nodeId: string, lyrics?: boolean) => void;
    onRearrange: (nodeId: string) => void;
    onExportText: (text: string, title?: string) => void;
    onDisconnect: (fromNodeId: string, toNodeId: string) => void;
    onStartSelection: (nodeId: string) => void;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [analysisEditor, setAnalysisEditor] = useState(false);
    const draft = readMusicDraft(node.metadata);
    const taskId = node.metadata?.musicTaskId;
    const pendingTask = hasResumableMusicTask(node);
    const analysisPending = !!node.metadata?.musicAnalysisId && (node.metadata.musicAnalysisStatus === "queued" || node.metadata.musicAnalysisStatus === "running");
    const locked = isRunning || pendingTask || analysisPending || Boolean(node.metadata?.musicSavePending);
    const update = (patch: Partial<MusicGenerationDraft>) => onConfigChange(node.id, { musicDraft: { ...draft, ...patch }, ...(patch.referenceNodeId !== undefined ? { musicReferenceStyle: undefined } : {}) });
    const inputStyle = { background: "transparent", color: theme.node.text };
    const textAreaClass = "thin-scrollbar !resize-none !rounded-xl !px-3 !py-2 !text-sm !leading-5";
    const actionClass = "!h-8 !shrink-0 !rounded-full !bg-transparent !px-2.5 !text-sm";
    const stage = node.metadata?.musicTaskStage || node.metadata?.musicTaskStatus;
    const knownStage = stage && ["queued", "planning", "instrumentalizing", "semantic", "synthesizing", "decoding", "saving", "completed", "failed"].includes(stage);
    const referenceNodes = connectedNodes.filter((source) => isMusicReferenceNode(source, nodes));
    const eligibleNodes = nodes.filter((item) => isMusicReferenceNode(item, nodes));
    const audioReferences = [...new Map(referenceNodes.flatMap((source) => source.type === CanvasNodeType.Group ? getGroupResourceNodes(source.id, nodes) : [source]).filter((item) => (item.type === CanvasNodeType.Audio || item.type === CanvasNodeType.Music) && item.metadata?.content).map((item) => [item.id, item])).values()];
    const selectedReference = selectMusicReference(node, audioReferences);
    const mode = draft.creationMode || "original";
    const outputType = draft.outputType || "song";
    const planningMode = mode === "melody" || mode === "full" ? mode : draft.cot;
    const analysis = readMusicReferenceAnalysis(node, selectedReference);
    const referenceStyle = node.metadata?.musicReferenceStyle ?? analysis?.style ?? "";
    const inheritedLyrics = analysis?.lyrics || (mode !== "original" ? analysis?.source_lyrics || selectedReference?.metadata?.musicRequest?.lyrics || "" : "");
    const effectiveLyrics = connectedLyrics.trim() ? connectedLyrics : inheritedLyrics;
    const hasReferenceInput = !!analysis && (mode === "style" ? !!analysis.style?.trim() && !!referenceStyle.trim() : !!(draft.abc.trim() || (mode === "melody" ? analysis.abc_melody?.trim() : analysis.abc_full?.trim())));
    const canGenerate = mode === "original" ? !!draft.style.trim() : hasReferenceInput && (mode === "style" || !!draft.style.trim());
    const settings = (
        <div data-canvas-no-zoom className="w-80 max-w-[calc(100vw-48px)] space-y-4 text-sm" style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                    <div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("canvas.music.seed")}</div>
                    <InputNumber<string> stringMode className="!w-full !rounded-xl [&_input]:!text-sm" aria-label={t("canvas.music.seed")} min="0" max={String(Number.MAX_SAFE_INTEGER)} precision={0} controls={false} disabled={locked} value={draft.seed || null} placeholder={t("canvas.music.randomSeed")} onChange={(value) => update({ seed: value ?? "" })} />
                </div>
                <div className="space-y-2">
                    <div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("canvas.music.format")}</div>
                    <Select value={draft.format} disabled={locked} onValueChange={(format) => update({ format: format as MusicFormat })}>
                        <SelectTrigger className="w-full rounded-xl" aria-label={t("canvas.music.format")}><SelectValue /></SelectTrigger>
                        <SelectContent data-canvas-no-zoom className="z-[1300]" position="popper" align="start"><SelectItem value="wav">WAV</SelectItem><SelectItem value="flac">FLAC</SelectItem></SelectContent>
                    </Select>
                </div>
                <div className="space-y-2">
                    <div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("canvas.music.steps")}</div>
                    <InputNumber<string> stringMode className="!w-full !rounded-xl [&_input]:!text-sm" aria-label={t("canvas.music.steps")} min="1" precision={0} disabled={locked} value={draft.steps || null} onChange={(value) => update({ steps: value ?? "" })} />
                </div>
                <div className="space-y-2">
                    <div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("canvas.music.cfg")}</div>
                    <InputNumber<string> stringMode className="!w-full !rounded-xl [&_input]:!text-sm" aria-label={t("canvas.music.cfg")} min="0" max="20" disabled={locked} value={draft.cfgScale || null} placeholder={t("canvas.music.autoCfg", { value: planningMode === "off" ? "1.01" : "1" })} onChange={(value) => update({ cfgScale: value ?? "" })} />
                </div>
                <div className="space-y-2">
                    <div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("canvas.music.temperature")}</div>
                    <InputNumber<string> stringMode className="!w-full !rounded-xl [&_input]:!text-sm" aria-label={t("canvas.music.temperature")} min="0" max="5" disabled={locked} value={draft.temperature || null} onChange={(value) => update({ temperature: value ?? "" })} />
                </div>
            </div>
            <details>
                <summary className="cursor-pointer text-sm">{t("canvas.music.sampling")}</summary>
                <div className="mt-3 space-y-4">
                    {(["abc", "semantic"] as const).map((phase) => {
                        const value = phase === "abc" ? draft.abcSampling || { temperature: "0.7", topP: "0.9", topK: "30", repetitionPenalty: "1.005" } : { temperature: draft.temperature, ...(draft.semanticSampling || { topP: "0.95", topK: "100", repetitionPenalty: "1.2" }) };
                        return <div key={phase} className="space-y-2"><div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t(`canvas.music.samplingPhases.${phase}`)}</div><div className="grid grid-cols-2 gap-2">
                            {(["temperature", "topP", "topK", "repetitionPenalty"] as const).map((key) => <div key={key}><div className="mb-1 text-xs" style={{ color: theme.node.muted }}>{t(`canvas.music.samplingFields.${key}`)}</div><InputNumber<string> stringMode className="!w-full !rounded-xl [&_input]:!text-sm" disabled={locked} value={value[key] || null} min={key === "topK" ? "1" : "0"} max={key === "temperature" ? "5" : key === "topP" ? "1" : undefined} precision={key === "topK" ? 0 : undefined} onChange={(next) => phase === "abc" ? update({ abcSampling: { ...value, [key]: next ?? "" } }) : key === "temperature" ? update({ temperature: next ?? "" }) : update({ semanticSampling: { topP: value.topP, topK: value.topK, repetitionPenalty: value.repetitionPenalty, [key]: next ?? "" } })} /></div>)}
                        </div></div>;
                    })}
                </div>
            </details>
            <p className="text-xs leading-5" style={{ color: theme.node.muted }}>{t("canvas.music.advancedHint")}</p>
            {mode !== "style" && (outputType === "instrumental" || planningMode !== "off") ? <div className="space-y-2">
                <div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("canvas.music.abc")}</div>
                <Input.TextArea aria-label={t("canvas.music.abc")} value={draft.abc} disabled={locked} onChange={(event) => update({ abc: event.target.value })} rows={4} className={`${textAreaClass} font-mono`} style={inputStyle} placeholder={t("canvas.music.abcPlaceholder")} />
            </div> : null}
        </div>
    );

    return (
        <ImageSettingsTheme theme={theme}>
            <div data-canvas-no-zoom className="rounded-2xl border p-3 text-sm shadow-2xl backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                <div inert={locked}>
                    <CanvasNodeReferenceBar nodeId={node.id} nodes={eligibleNodes} connectedNodes={referenceNodes} onDisconnect={onDisconnect} onStartSelection={onStartSelection} />
                </div>
                <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
                    <Segmented value={outputType} disabled={locked} onChange={(value) => update({ outputType: value as MusicOutputType })} options={[{ value: "song", label: t("canvas.music.outputTypes.song") }, { value: "instrumental", label: t("canvas.music.outputTypes.instrumental") }]} />
                </div>
                <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
                    <Select value={mode} disabled={locked} onValueChange={(creationMode) => update({ creationMode: creationMode as MusicCreationMode, abc: "" })}>
                        <SelectTrigger className="shrink-0 rounded-full" aria-label={t("canvas.music.creationMode")}><SelectValue /></SelectTrigger>
                        <SelectContent data-canvas-no-zoom className="z-[1200]" position="popper" align="start">{(["original", "melody", "full", "style"] as const).map((value) => <SelectItem key={value} value={value}>{t(`canvas.music.creationModes.${value}`)}</SelectItem>)}</SelectContent>
                    </Select>
                    {audioReferences.length > 1 ? <Select value={selectedReference?.id || ""} disabled={locked} onValueChange={(referenceNodeId) => update({ referenceNodeId, abc: "" })}>
                        <SelectTrigger className="min-w-0 max-w-52 rounded-full" aria-label={t("canvas.music.mainReference")}><SelectValue placeholder={t("canvas.music.mainReference")} /></SelectTrigger>
                        <SelectContent data-canvas-no-zoom className="z-[1200] max-w-80" position="popper" align="start">{audioReferences.map((reference) => <SelectItem key={reference.id} value={reference.id}>{reference.title}</SelectItem>)}</SelectContent>
                    </Select> : mode !== "original" && selectedReference ? <span className="min-w-0 max-w-52 truncate text-xs" style={{ color: theme.node.muted }} title={selectedReference.title}>{selectedReference.title}</span> : null}
                    {mode !== "original" ? <Button type="text" disabled={locked || !selectedReference} className={actionClass} icon={<Settings2 className="size-3.5" />} onClick={() => onAnalyze(node.id)}>{t("canvas.music.analyzeReference")}</Button> : null}
                </div>
                {mode !== "original" ? <p className="mb-2 text-xs leading-5" style={{ color: theme.node.muted }}>{t(`canvas.music.creationHints.${mode}`)}</p> : null}
                {analysis || selectedReference ? <div className="mb-2 flex flex-wrap gap-1">
                    {analysis ? <Button type="text" className={actionClass} icon={<FileText className="size-3.5" />} onClick={() => setAnalysisEditor(true)}>{t("canvas.music.viewAnalysis")}</Button> : null}
                    {outputType !== "instrumental" ? <Button type="text" disabled={locked || !selectedReference} className={actionClass} onClick={() => onAnalyze(node.id, true)}>{t("canvas.music.extractLyrics")}</Button> : null}
                </div> : null}
                {mode !== "original" && !analysis && !analysisPending ? <p className="mb-2 text-xs leading-5" style={{ color: theme.node.muted }}>{t(selectedReference ? "canvas.music.analyzeFirst" : "canvas.music.referenceRequired")}</p> : null}
                {analysis || analysisPending ? <div className="mb-2 flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}>{analysisPending && isRunning ? <LoaderCircle className="size-3.5 animate-spin" /> : null}{t(`canvas.music.analysisStages.${node.metadata?.musicAnalysisStage || "queued"}`)}</div> : null}
                <div className="space-y-2">
                    <div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("canvas.music.style")}</div>
                    <Input.TextArea aria-label={t("canvas.music.style")} variant="borderless" value={draft.style} disabled={locked} onChange={(event) => update({ style: event.target.value })} rows={2} className={textAreaClass} style={inputStyle} placeholder={t(outputType === "instrumental" ? "canvas.music.instrumentalStylePlaceholder" : "canvas.music.stylePlaceholder")} />
                    {outputType !== "instrumental" ? <>
                        <div className="text-xs font-medium" style={{ color: theme.node.muted }}>{t("canvas.music.lyrics")}</div>
                        <Input.TextArea aria-label={t("canvas.music.lyrics")} variant="borderless" value={draft.lyrics} disabled={locked} onChange={(event) => update({ lyrics: event.target.value })} rows={3} className={textAreaClass} style={inputStyle} placeholder={t("canvas.music.lyricsPlaceholder")} />
                    </> : null}
                </div>
                {mode === "style" && analysis?.style ? <p className="mt-1 line-clamp-2 text-xs leading-5" style={{ color: theme.node.muted }}>{t("canvas.music.referenceStyle")}: {referenceStyle}</p> : null}
                {outputType === "instrumental" ? <p className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>{connectedLyrics.trim() ? t("canvas.music.instrumentalLyricsIgnored") : t("canvas.music.instrumentalHint")}</p> : <>
                    <p className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>{draft.lyrics.trim() ? t("canvas.music.explicitLyrics") : connectedLyrics.trim() ? t("canvas.music.connectedLyrics") : inheritedLyrics.trim() ? t("canvas.music.referenceLyrics") : t("canvas.music.emptyLyricsHint")}</p>
                    {!draft.lyrics.trim() && effectiveLyrics.trim() ? <pre className="thin-scrollbar mt-2 max-h-20 overflow-auto whitespace-pre-wrap break-words text-sm leading-5" style={{ color: theme.node.muted }}>{effectiveLyrics}</pre> : null}
                </>}
                <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="inline-flex shrink-0 items-center gap-1.5 px-1 text-sm"><Music4 className="size-3.5" />{MUSIC_MODEL}</span>
                        {outputType === "instrumental" ? <span className="inline-flex h-8 shrink-0 items-center rounded-full px-2.5 text-xs" style={{ color: theme.node.muted }}>{t("canvas.music.instrumentalPlanning")}</span> : <Select value={planningMode} disabled={locked || mode === "melody" || mode === "full"} onValueChange={(cot) => update({ cot: cot as MusicPlanningMode })}>
                            <SelectTrigger className="h-8 rounded-full" aria-label={t("canvas.music.planning")}><SelectValue /></SelectTrigger>
                            <SelectContent data-canvas-no-zoom className="z-[1200]" position="popper" align="start">
                                {(["full", "melody", "off"] as const).map((mode) => <SelectItem key={mode} value={mode}>{t(`canvas.music.planningModes.${mode}`)}</SelectItem>)}
                            </SelectContent>
                        </Select>}
                        <Popover content={settings} trigger="click" placement="topLeft" open={settingsOpen} onOpenChange={setSettingsOpen} destroyOnHidden styles={{ root: { zIndex: 1200 }, body: { padding: 16, maxHeight: "70dvh", overflowY: "auto" } }}>
                            <Button type="text" className={actionClass} style={{ color: theme.node.text }} icon={<Settings2 className="size-3.5" />} aria-label={t("canvas.music.advanced")}>{t("canvas.music.advanced")}</Button>
                        </Popover>
                        {node.metadata?.musicScore || node.metadata?.musicOutput?.has_score ? <Tooltip title={t("canvas.music.downloadScore")}><Button type="text" className="!h-8 !w-8 !min-w-8 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Download className="size-3.5" />} aria-label={t("canvas.music.downloadScore")} onClick={() => onDownloadScore(node.id)} /></Tooltip> : null}
                        {outputType === "instrumental" && (node.metadata?.musicOutput?.has_score || node.metadata?.musicTaskStatus === "failed") ? <Tooltip title={t("canvas.music.downloadSourceScore")}><Button type="text" className="!h-8 !w-8 !min-w-8 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<FileText className="size-3.5" />} aria-label={t("canvas.music.downloadSourceScore")} onClick={() => onDownloadScore(node.id, "source")} /></Tooltip> : null}
                    </div>
                    {isRunning ? <Button type="primary" danger className="!h-10 !shrink-0 !rounded-full !px-3" icon={<LoaderCircle className="size-4 animate-spin" />} onClick={() => onStop(node.id)}><Square className="size-3.5 fill-current" />{t("canvas.music.stopQuery")}</Button> : node.metadata?.musicSavePending ? <Button type="text" className={actionClass} icon={<RefreshCw className="size-3.5" />} onClick={() => onQuery(node.id)}>{t("canvas.music.retrySave")}</Button> : pendingTask || analysisPending ? <Button type="text" className={actionClass} icon={<RefreshCw className="size-3.5" />} onClick={() => onQuery(node.id)}>{t("canvas.music.continueQuery")}</Button> : <Button type="primary" className="!h-10 !min-w-16 !shrink-0 !rounded-full !px-3" disabled={!canGenerate} aria-label={t(node.metadata?.musicTaskStatus === "failed" || node.metadata?.musicContentUnavailable ? "canvas.music.retryNewTask" : node.metadata?.content ? "canvas.music.generateNext" : "canvas.music.generate")} icon={<ArrowUp className="size-4" />} onClick={() => onGenerate(node.id)} />}
                </div>
                {taskId ? <div className="mt-2 space-y-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                    <div className="truncate" title={taskId}>{t("canvas.music.taskId")}: {taskId}</div>
                    {stage ? <div>{knownStage ? t(`canvas.music.stages.${stage}`) : stage}{node.metadata?.musicSeed !== undefined ? ` · ${t("canvas.music.actualSeed")}: ${node.metadata.musicSeed}` : ""}</div> : null}
                    {node.metadata?.musicTaskMissing ? <p>{t("canvas.music.taskNotFound")}</p> : pendingTask ? <p>{t("canvas.music.queryOnlyHint")}</p> : null}
                    {node.metadata?.content ? <Button type="text" className={actionClass} style={{ color: theme.node.text }} icon={<Music4 className="size-3.5" />} onClick={() => onRearrange(node.id)}>{t("canvas.music.rearrange")}</Button> : null}
                    {node.metadata?.musicOutput?.truncated.abc || node.metadata?.musicOutput?.truncated.semantic ? <p>{t("canvas.music.truncated")}</p> : null}
                    {node.metadata?.musicOutput?.instrumental?.affected_ins_notes ? <p>{t("canvas.music.instrumentalTrimmed")}</p> : null}
                    {pendingTask && !isRunning && node.metadata?.musicTaskMissing && node.metadata.musicRequest ? <Button type="text" className={actionClass} style={{ color: theme.node.text }} icon={<RefreshCw className="size-3.5" />} onClick={() => onResubmit(node.id)}>{t("canvas.music.resubmit")}</Button> : null}
                </div> : null}
                {node.metadata?.musicError ? <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5" style={{ color: theme.node.muted }}>{node.metadata.musicError}</p> : null}
            </div>
            <Modal title={t("canvas.music.viewAnalysis")} open={analysisEditor && !!analysis} onCancel={() => setAnalysisEditor(false)} footer={null} width={760} centered destroyOnHidden>
                <div data-canvas-no-zoom className="space-y-4" onWheel={(event) => event.stopPropagation()}>
                    {analysis?.style ? <div className="space-y-2"><div className="flex items-center justify-between text-sm"><span>{t("canvas.music.referenceStyle")}</span><Button type="text" disabled={!referenceStyle.trim()} icon={<FileText className="size-3.5" />} onClick={() => onExportText(referenceStyle, t("canvas.music.referenceStyle"))}>{t("canvas.music.exportText")}</Button></div><Input.TextArea value={referenceStyle} disabled={locked} onChange={(event) => onConfigChange(node.id, { musicReferenceStyle: event.target.value })} rows={4} className={textAreaClass} style={inputStyle} /></div> : null}
                    {analysis?.abc_full || analysis?.abc_melody ? <div className="space-y-2"><div className="text-sm">{t("canvas.music.abc")}</div><Input.TextArea className={`${textAreaClass} font-mono`} style={inputStyle} value={draft.abc || (mode === "melody" ? analysis.abc_melody : analysis.abc_full) || ""} disabled={locked || mode === "style"} onChange={(event) => update({ abc: event.target.value })} rows={10} /><p className="text-xs" style={{ color: theme.node.muted }}>{t("canvas.music.scoreEditHint")}</p></div> : null}
                    {outputType !== "instrumental" && (analysis?.lyrics || analysis?.source_lyrics) ? <div className="space-y-2"><div className="flex items-center justify-between text-sm"><span>{t("canvas.music.lyrics")}</span><Button type="text" icon={<FileText className="size-3.5" />} onClick={() => onExportText(draft.lyrics || analysis.lyrics || analysis.source_lyrics!, t("canvas.music.lyrics"))}>{t("canvas.music.exportText")}</Button></div><Input.TextArea value={draft.lyrics || analysis.lyrics || analysis.source_lyrics} disabled={locked} onChange={(event) => update({ lyrics: event.target.value })} rows={6} className={textAreaClass} style={inputStyle} /></div> : null}
                    {analysis?.warnings.map((warning, index) => <p key={index} className="text-xs" style={{ color: theme.node.muted }}>{warning}</p>)}
                </div>
            </Modal>
        </ImageSettingsTheme>
    );
}
