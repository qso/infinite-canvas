import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";

import { AudioSettingsPanel, type AudioSettingKey } from "@workbench/components/audio-settings-panel";
import { isFireRedSpeech } from "@workbench/constant/firered";
import { audioFormatLabel, audioSpeedLabel, audioVoiceLabel } from "@workbench/lib/audio-generation";
import { canvasThemes } from "@workbench/lib/canvas-theme";
import { useThemeStore } from "@workbench/stores/use-theme-store";
import type { AiConfig } from "@workbench/stores/use-config-store";
import type { CanvasNodeData } from "@infinite-canvas/shared/canvas/schema/canvas";

export type CanvasAudioSettingKey = AudioSettingKey;

type CanvasAudioSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
    metadata?: CanvasNodeData["metadata"];
    hasAudioReference?: boolean;
    onAutoTranscribe?: () => Promise<string>;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

const fireRedModeLabels: Record<string, string> = { clone: "声音克隆", design: "声音设计", edit: "语音编辑" };
const fireRedLangLabels: Record<string, string> = { auto: "自动", zh: "中文", en: "英文" };

export function CanvasAudioSettingsPopover({ config, onConfigChange, metadata, hasAudioReference = false, onAutoTranscribe, buttonClassName, placement = "topLeft" }: CanvasAudioSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const fireRed = isFireRedSpeech(config.model);
    const fireRedMode = metadata?.audioFireRedMode === "design" || metadata?.audioFireRedMode === "edit" ? metadata.audioFireRedMode : "clone";
    const fireRedLang = metadata?.audioFireRedLanguage === "en" || metadata?.audioFireRedLanguage === "zh" ? metadata.audioFireRedLanguage : "auto";
    const summary = fireRed
        ? `${fireRedModeLabels[fireRedMode]} · ${fireRedLangLabels[fireRedLang]}`
        : `${audioVoiceLabel(config.audioVoice)} · ${audioFormatLabel(config.audioFormat)} · ${audioSpeedLabel(config.audioSpeed)}`;

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const panel = open && buttonRect ? <AudioSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} metadata={metadata} hasAudioReference={hasAudioReference} onAutoTranscribe={onAutoTranscribe} onConfigChange={onConfigChange} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button type="button" size="sm" variant="ghost" aria-expanded={open} aria-label="音频生成设置" className={buttonClassName || "h-8 max-w-[200px] justify-start rounded-full px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} onClick={() => setOpen((current) => !current)}>
                    <Settings2 className="size-3.5" />
                    <span className="truncate">{summary}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function AudioSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    metadata,
    hasAudioReference,
    onAutoTranscribe,
    onConfigChange,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasAudioSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    metadata?: CanvasNodeData["metadata"];
    hasAudioReference?: boolean;
    onAutoTranscribe?: () => Promise<string>;
    onConfigChange: (key: CanvasAudioSettingKey, value: string) => void;
}) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            data-canvas-no-zoom
            data-canvas-shortcuts-ignore
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <AudioSettingsPanel config={config} metadata={metadata} hasAudioReference={hasAudioReference} onAutoTranscribe={onAutoTranscribe} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" />
        </div>,
        document.body,
    );
}
