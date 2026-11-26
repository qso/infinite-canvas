import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2, Volume2, VolumeX } from "lucide-react";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";

import { VideoSettingsPanel, videoAudioLabel, videoModeLabel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@workbench/components/video-settings-panel";
import { isMiniMaxH3 } from "@workbench/constant/comfyui";
import { getDreamMakerVideoSpec } from "@workbench/constant/dreammaker";
import { canvasThemes } from "@workbench/lib/canvas-theme";
import { useThemeStore } from "@workbench/stores/use-theme-store";
import { boolConfig, type AiConfig } from "@workbench/stores/use-config-store";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CanvasVideoSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft" }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

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

    const activeModel = config.model || config.videoModel;
    const dmSpec = getDreamMakerVideoSpec(activeModel);
    const showAudioBadge = isMiniMaxH3(activeModel) || Boolean(dmSpec?.supportsAudioToggle);
    const displayResolution = dmSpec ? (config.vquality === "480_draft" && dmSpec.resolutions.includes("480_draft") ? "480_draft" : dmSpec.resolutions.includes(config.vquality) ? config.vquality : dmSpec.defaultResolution) : config.vquality;
    const panel = open && buttonRect ? <VideoSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} onConfigChange={onConfigChange} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button type="button" size="sm" variant="ghost" aria-expanded={open} aria-label="视频生成设置" className={buttonClassName || "h-8 max-w-[220px] justify-start rounded-full px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} onClick={() => setOpen((current) => !current)}>
                    <Settings2 className="size-3.5" />
                    <span className="truncate">
                        {videoResolutionLabel(displayResolution)} · {videoSizeLabel(config.videoSize || config.size)} · {videoSecondsLabel(config.videoSeconds)} · {videoModeLabel(config.videoMode)}
                    </span>
                    {showAudioBadge ? (
                        <span className="shrink-0" title={videoAudioLabel(config.videoGenerateAudio)} aria-label={videoAudioLabel(config.videoGenerateAudio)}>
                            {boolConfig(config.videoGenerateAudio, true) ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
                        </span>
                    ) : null}
                </Button>
            </span>
            {panel}
        </>
    );
}

function VideoSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    onConfigChange,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasVideoSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
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
            <VideoSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" />
        </div>,
        document.body,
    );
}
