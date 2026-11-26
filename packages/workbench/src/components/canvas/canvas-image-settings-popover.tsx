import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel, type ImageReferenceInfo } from "@workbench/components/image-settings-panel";
import { isQwenImage21 } from "@workbench/constant/comfyui";
import { getDreamMakerImageSpec } from "@workbench/constant/dreammaker";
import { canvasThemes } from "@workbench/lib/canvas-theme";
import { useThemeStore } from "@workbench/stores/use-theme-store";
import { boolConfig, type AiConfig } from "@workbench/stores/use-config-store";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    fixedRatio?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
    imageReferences?: ImageReferenceInfo;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, buttonClassName, fixedRatio, placement = "topLeft", imageReferences }: CanvasImageSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
    const quality = config.quality || "auto";
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const activeModel = config.model || config.imageModel;
    const qwen = isQwenImage21(activeModel);
    const dmSpec = getDreamMakerImageSpec(activeModel);
    const hasImageReferences = (imageReferences?.count || 0) > 0;
    const qwenResolutionLabels: Record<string, string> = { "0": "跟随原图", "1024": "1K", "1536": "1.5K", "2048": "2K", "4096": "4K" };
    const qwenResolutionLabel = qwenResolutionLabels[config.imageResolution || "1024"] || `${config.imageResolution}px`;
    const qwenSummaryResolution = !hasImageReferences && (config.imageResolution || "1024") === "0" ? "1K" : qwenResolutionLabel;
    const summaryText = (() => {
        if (qwen) return `${qwenSummaryResolution} · ${imageSizeLabel(activeSize)}${fixedRatio ? "" : ` · ${count} 张`}`;
        if (dmSpec?.family === "mj") {
            const mjQuality = !dmSpec.niji && boolConfig(config.dmMjHd, false) ? "2K" : "标准";
            const mjCount = Math.max(4, Math.min(12, Math.ceil(count / 4) * 4));
            return `${mjQuality} · ${imageSizeLabel(activeSize)}${fixedRatio ? "" : ` · ${mjCount} 张`}`;
        }
        if (dmSpec?.family === "ark") {
            const tiers = dmSpec.arkTiers || ["1K", "2K"];
            const tier = tiers.includes((config.dmArkSizeTier || "").toUpperCase()) ? (config.dmArkSizeTier || "").toUpperCase() : tiers.includes("2K") ? "2K" : tiers[0];
            const sizeText = /^\d+x\d+$/i.test(activeSize) ? activeSize : `${tier} · ${imageSizeLabel(activeSize)}`;
            return `${sizeText}${fixedRatio ? "" : ` · ${count} 张`}`;
        }
        return `${imageQualityLabel(quality)} · ${imageSizeLabel(activeSize)}${fixedRatio ? "" : ` · ${count} 张`}`;
    })();
    const updateOpen = (nextOpen: boolean) => {
        setOpen(nextOpen);
        onOpenChange?.(nextOpen);
    };

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            if (document.activeElement instanceof HTMLElement && panelRef.current?.contains(document.activeElement)) document.activeElement.blur();
            setOpen(false);
            onOpenChange?.(false);
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
    }, [onOpenChange, open]);

    const panel = open && buttonRect ? <ImageSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} fixedRatio={fixedRatio} imageReferences={imageReferences} onConfigChange={onConfigChange} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button type="button" size="sm" variant="ghost" aria-expanded={open} className={buttonClassName || "h-8 max-w-[180px] justify-start rounded-full px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} onClick={() => updateOpen(!open)}>
                    <Settings2 className="size-3.5" />
                    <span className="truncate">{summaryText}</span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function ImageSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    fixedRatio,
    imageReferences,
    onConfigChange,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasImageSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    fixedRatio?: string;
    imageReferences?: ImageReferenceInfo;
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
            <ImageSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} fixedRatio={fixedRatio} imageReferences={imageReferences} className="space-y-4" />
        </div>,
        document.body,
    );
}
