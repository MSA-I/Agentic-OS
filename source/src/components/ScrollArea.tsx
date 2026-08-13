"use client";

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export type ScrollAreaState = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  overflow: boolean;
  atStart: boolean;
  atEnd: boolean;
};

type ScrollbarMode = "auto" | "always" | "hover" | "hidden";
type OverscrollMode = "auto" | "contain";
type FadeOptions = boolean | { start?: boolean; end?: boolean };

export type ScrollAreaProps = {
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  viewportClassName?: string;
  contentClassName?: string;
  scrollbar?: ScrollbarMode;
  fades?: FadeOptions;
  overscroll?: OverscrollMode;
  viewportRef?: Ref<HTMLDivElement>;
  onScrollStateChange?: (state: ScrollAreaState) => void;
  children: ReactNode;
};

type InternalState = ScrollAreaState & {
  maxScroll: number;
  thumbHeight: number;
  thumbOffset: number;
};

const INITIAL_STATE: InternalState = {
  scrollTop: 0,
  scrollHeight: 0,
  clientHeight: 0,
  overflow: false,
  atStart: true,
  atEnd: true,
  maxScroll: 0,
  thumbHeight: 0,
  thumbOffset: 0,
};

function joinClasses(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export default function ScrollArea({
  ariaLabel,
  className,
  style,
  viewportClassName,
  contentClassName,
  scrollbar = "auto",
  fades = true,
  overscroll = "auto",
  viewportRef,
  onScrollStateChange,
  children,
}: ScrollAreaProps) {
  const internalViewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const callbackRef = useRef(onScrollStateChange);
  const stateRef = useRef<InternalState>(INITIAL_STATE);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    scrollPerPixel: number;
  } | null>(null);
  const [state, setState] = useState<InternalState>(INITIAL_STATE);
  const [dragging, setDragging] = useState(false);

  useImperativeHandle(viewportRef, () => internalViewportRef.current as HTMLDivElement, []);

  useEffect(() => {
    callbackRef.current = onScrollStateChange;
  }, [onScrollStateChange]);

  const measure = useCallback(() => {
    frameRef.current = null;
    const viewport = internalViewportRef.current;
    if (!viewport) return;

    const scrollTop = viewport.scrollTop;
    const scrollHeight = viewport.scrollHeight;
    const clientHeight = viewport.clientHeight;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const overflow = maxScroll > 1;
    const trackHeight = trackRef.current?.clientHeight || clientHeight;
    const thumbHeight = overflow
      ? Math.min(trackHeight, Math.max(24, trackHeight * (clientHeight / scrollHeight)))
      : trackHeight;
    const thumbTravel = Math.max(0, trackHeight - thumbHeight);
    const thumbOffset = maxScroll > 0 ? thumbTravel * (scrollTop / maxScroll) : 0;
    const next: InternalState = {
      scrollTop,
      scrollHeight,
      clientHeight,
      maxScroll,
      overflow,
      atStart: scrollTop <= 1,
      atEnd: !overflow || maxScroll - scrollTop <= 1,
      thumbHeight,
      thumbOffset,
    };
    const previous = stateRef.current;
    const changed = Object.keys(next).some((key) => previous[key as keyof InternalState] !== next[key as keyof InternalState]);
    if (!changed) return;

    stateRef.current = next;
    setState(next);
    callbackRef.current?.({ scrollTop, scrollHeight, clientHeight, overflow, atStart: next.atStart, atEnd: next.atEnd });
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(measure);
  }, [measure]);

  useEffect(() => {
    const viewport = internalViewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;

    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(viewport);
    observer.observe(content);
    viewport.addEventListener("scroll", scheduleMeasure, { passive: true });
    scheduleMeasure();

    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", scheduleMeasure);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [scheduleMeasure]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const handleThumbPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = internalViewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track || !stateRef.current.overflow || scrollbar === "hidden") return;

    const thumbTravel = Math.max(0, track.clientHeight - stateRef.current.thumbHeight);
    if (thumbTravel <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: viewport.scrollTop,
      scrollPerPixel: stateRef.current.maxScroll / thumbTravel,
    };
    setDragging(true);
  }, [scrollbar]);

  const handleThumbPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const viewport = internalViewportRef.current;
    if (!drag || !viewport || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    viewport.scrollTop = drag.startScrollTop + (event.clientY - drag.startY) * drag.scrollPerPixel;
    scheduleMeasure();
  }, [scheduleMeasure]);

  const handleViewportKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const viewport = internalViewportRef.current;
    if (!viewport) return;

    const pageStep = Math.max(40, viewport.clientHeight * 0.9);
    if (event.key === "Home") viewport.scrollTop = 0;
    else if (event.key === "End") viewport.scrollTop = viewport.scrollHeight;
    else if (event.key === "PageUp") viewport.scrollTop -= pageStep;
    else if (event.key === "PageDown") viewport.scrollTop += pageStep;
    else return;

    event.preventDefault();
    scheduleMeasure();
  }, [scheduleMeasure]);

  const startFade = typeof fades === "boolean" ? fades : fades.start ?? true;
  const endFade = typeof fades === "boolean" ? fades : fades.end ?? true;

  return (
    <div
      className={joinClasses("scroll-area", className)}
      style={style}
      data-scroll-area
      data-scrollbar={scrollbar}
      data-overscroll={overscroll}
      data-overflow-y={state.overflow ? "true" : "false"}
      data-at-start={state.atStart ? "true" : "false"}
      data-at-end={state.atEnd ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
    >
      <div
        ref={internalViewportRef}
        className={joinClasses("scroll-area__viewport", viewportClassName)}
        role={ariaLabel ? "region" : undefined}
        aria-label={ariaLabel}
        tabIndex={ariaLabel ? 0 : undefined}
        onKeyDown={handleViewportKeyDown}
        data-scroll-viewport
        style={{ overscrollBehaviorY: overscroll }}
      >
        <div ref={contentRef} className={joinClasses("scroll-area__content", contentClassName)}>
          {children}
        </div>
      </div>

      {startFade && <div aria-hidden className="scroll-area__fade scroll-area__fade--start" data-visible={state.overflow && !state.atStart ? "true" : "false"} />}
      {endFade && <div aria-hidden className="scroll-area__fade scroll-area__fade--end" data-visible={state.overflow && !state.atEnd ? "true" : "false"} />}

      <div ref={trackRef} aria-hidden className="scroll-area__track" data-scroll-track>
        <div
          className="scroll-area__thumb"
          data-scroll-thumb
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag}
          style={{ height: `${state.thumbHeight}px`, transform: `translateY(${state.thumbOffset}px)` }}
        />
      </div>
    </div>
  );
}
