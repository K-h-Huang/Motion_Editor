import type { MotionCurveChannel } from '../types/viewer';

interface MotionCurveEditorOptions {
  canvas: HTMLCanvasElement;
  channelSelect: HTMLSelectElement;
  axisSelect: HTMLSelectElement;
  statusElement: HTMLElement;
  onChannelSelected?: (channelId: string | null) => void;
  onFrameSelected?: (frameIndex: number) => void;
  onValueEdited?: (channelId: string, frameIndex: number, value: number) => void;
  onRangeSelected?: (startFrame: number | null, endFrame: number | null) => void;
}

interface PlotBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export class MotionCurveEditor {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly channelSelect: HTMLSelectElement;
  private readonly axisSelect: HTMLSelectElement;
  private readonly statusElement: HTMLElement;
  private readonly onChannelSelected?: (channelId: string | null) => void;
  private readonly onFrameSelected?: (frameIndex: number) => void;
  private readonly onValueEdited?: (channelId: string, frameIndex: number, value: number) => void;
  private readonly onRangeSelected?: (startFrame: number | null, endFrame: number | null) => void;
  private readonly dpr: number;

  private channels: MotionCurveChannel[] = [];
  private selectedChannelId: string | null = null;
  private values: Float32Array<ArrayBufferLike> = new Float32Array();
  private currentFrame = 0;
  private frameCount = 0;
  private fps = 30;
  private editingPointerId: number | null = null;
  private rangeSelectingPointerId: number | null = null;
  private rangeSelectionAnchorFrame: number | null = null;
  private selectedRangeStart: number | null = null;
  private selectedRangeEnd: number | null = null;

  constructor(options: MotionCurveEditorOptions) {
    this.canvas = options.canvas;
    this.channelSelect = options.channelSelect;
    this.axisSelect = options.axisSelect;
    this.statusElement = options.statusElement;
    this.onChannelSelected = options.onChannelSelected;
    this.onFrameSelected = options.onFrameSelected;
    this.onValueEdited = options.onValueEdited;
    this.onRangeSelected = options.onRangeSelected;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Curve editor canvas 2D context is unavailable.');
    }
    this.ctx = ctx;
    this.dpr = globalThis.devicePixelRatio || 1;

    this.channelSelect.addEventListener('change', this.handleChannelSelectChange);
    this.axisSelect.addEventListener('change', this.handleAxisSelectChange);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerUp);
    this.canvas.addEventListener('pointerleave', this.handlePointerUp);

    this.resize();
  }

  dispose(): void {
    this.channelSelect.removeEventListener('change', this.handleChannelSelectChange);
    this.axisSelect.removeEventListener('change', this.handleAxisSelectChange);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
    this.canvas.removeEventListener('pointerleave', this.handlePointerUp);
  }

  clear(): void {
    this.channels = [];
    this.selectedChannelId = null;
    this.values = new Float32Array();
    this.currentFrame = 0;
    this.frameCount = 0;
    this.selectedRangeStart = null;
    this.selectedRangeEnd = null;
    this.editingPointerId = null;
    this.rangeSelectingPointerId = null;
    this.rangeSelectionAnchorFrame = null;
    this.renderChannelOptions();
    this.setStatus('Choose a motion target to inspect its curve.');
    this.render();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width * this.dpr));
    const height = Math.max(1, Math.floor(rect.height * this.dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);
    this.render();
  }

  setChannels(channels: MotionCurveChannel[], selectedChannelId: string | null): void {
    this.channels = [...channels];
    const isSelectedValid = Boolean(
      selectedChannelId && channels.some((channel) => channel.id === selectedChannelId),
    );
    this.selectedChannelId = isSelectedValid ? selectedChannelId : channels[0]?.id ?? null;
    this.renderChannelOptions();
    this.render();
  }

  setSeries(values: Float32Array, currentFrame: number, frameCount: number, fps: number): void {
    this.values = values;
    this.currentFrame = frameCount > 0 ? Math.max(0, Math.min(frameCount - 1, currentFrame)) : 0;
    this.frameCount = Math.max(0, frameCount);
    this.fps = fps;
    this.setStatus(this.buildStatusMessage());
    this.render();
  }

  setCurrentFrame(frameIndex: number): void {
    this.currentFrame = this.frameCount > 0
      ? Math.max(0, Math.min(this.frameCount - 1, frameIndex))
      : 0;
    this.setStatus(this.buildStatusMessage());
    this.render();
  }

  setSelectedChannel(channelId: string | null): void {
    const isValid = Boolean(channelId && this.channels.some((channel) => channel.id === channelId));
    this.selectedChannelId = isValid ? channelId : null;
    this.renderChannelOptions();
    this.setStatus(this.buildStatusMessage());
    this.render();
  }

  setSelectedRange(startFrame: number | null, endFrame: number | null): void {
    this.updateSelectedRange(startFrame, endFrame, false);
  }

  private readonly handleChannelSelectChange = (): void => {
    const nextGroupId = this.channelSelect.value.trim();
    this.syncAxisOptions(nextGroupId || null);
    this.selectedChannelId = this.resolveSelectedChannelId(nextGroupId || null, this.axisSelect.value.trim() || null);
    this.setStatus(this.buildStatusMessage());
    this.render();
    this.onChannelSelected?.(this.selectedChannelId);
  };

  private readonly handleAxisSelectChange = (): void => {
    const groupId = this.channelSelect.value.trim() || null;
    const axisValue = this.axisSelect.value.trim() || null;
    this.selectedChannelId = this.resolveSelectedChannelId(groupId, axisValue);
    this.setStatus(this.buildStatusMessage());
    this.render();
    this.onChannelSelected?.(this.selectedChannelId);
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.frameCount <= 0) {
      return;
    }

    const localPoint = this.getCanvasPoint(event);
    const bounds = this.getPlotBounds();
    if (!this.isInsidePlot(localPoint.x, localPoint.y, bounds)) {
      return;
    }

    const frameIndex = this.frameFromX(localPoint.x, bounds);
    this.onFrameSelected?.(frameIndex);
    if (event.ctrlKey || event.metaKey) {
      this.beginRangeSelection(event.pointerId, frameIndex);
      return;
    }

    if (!this.selectedChannelId || this.values.length === 0) {
      return;
    }

    const pointY = this.valueToY(this.values[frameIndex] ?? 0, bounds);
    const shouldEdit = event.shiftKey || Math.abs(localPoint.y - pointY) <= 14;
    if (!shouldEdit) {
      return;
    }

    this.editingPointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
    this.editValueAt(localPoint.x, localPoint.y, bounds);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.rangeSelectingPointerId === event.pointerId) {
      const localPoint = this.getCanvasPoint(event);
      const bounds = this.getPlotBounds();
      const frameIndex = this.frameFromX(
        Math.max(bounds.left, Math.min(bounds.right, localPoint.x)),
        bounds,
      );
      this.updateSelectedRange(this.rangeSelectionAnchorFrame, frameIndex, true);
      return;
    }

    if (this.editingPointerId !== event.pointerId) {
      return;
    }

    const localPoint = this.getCanvasPoint(event);
    const bounds = this.getPlotBounds();
    this.editValueAt(localPoint.x, localPoint.y, bounds);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.rangeSelectingPointerId === event.pointerId) {
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      this.rangeSelectingPointerId = null;
      this.rangeSelectionAnchorFrame = null;
      return;
    }

    if (this.editingPointerId !== event.pointerId) {
      return;
    }

    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.editingPointerId = null;
  };

  private editValueAt(localX: number, localY: number, bounds: PlotBounds): void {
    if (!this.selectedChannelId || this.frameCount <= 0) {
      return;
    }

    const clampedX = Math.max(bounds.left, Math.min(bounds.right, localX));
    const clampedY = Math.max(bounds.top, Math.min(bounds.bottom, localY));
    const frameIndex = this.frameFromX(clampedX, bounds);
    const value = this.yToValue(clampedY, bounds);
    this.onFrameSelected?.(frameIndex);
    this.onValueEdited?.(this.selectedChannelId, frameIndex, value);
  }

  private renderChannelOptions(): void {
    const previousGroupId = this.selectedChannelId ? this.getChannelGroupId(this.selectedChannelId) : this.channelSelect.value;
    const previousAxisValue = this.selectedChannelId ? this.getChannelAxisValue(this.selectedChannelId) : this.axisSelect.value;
    this.channelSelect.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = this.channels.length > 0 ? 'Select target...' : 'No curve channels';
    this.channelSelect.appendChild(placeholder);

    const groups = this.getChannelGroups();
    for (const group of groups) {
      const option = document.createElement('option');
      option.value = group.groupId;
      option.textContent = group.label;
      this.channelSelect.appendChild(option);
    }

    const selectedGroupId = this.selectPreferredGroupId(previousGroupId || null);
    this.channelSelect.value = selectedGroupId ?? '';
    this.syncAxisOptions(selectedGroupId, previousAxisValue || null);
    this.selectedChannelId = this.resolveSelectedChannelId(
      selectedGroupId,
      this.axisSelect.value.trim() || null,
    );
    this.channelSelect.disabled = this.channels.length === 0;
  }

  private buildStatusMessage(): string {
    if (!this.selectedChannelId || this.channels.length === 0 || this.values.length === 0) {
      return 'Choose a motion target. Drag near the curve, hold Shift to force point edits, or hold Ctrl/Cmd while dragging to select a frame range.';
    }

    const channel = this.channels.find((item) => item.id === this.selectedChannelId);
    const currentValue = this.values[this.currentFrame] ?? 0;
    const timeSeconds = this.currentFrame / Math.max(this.fps, 1);
    const rangeLabel =
      this.selectedRangeStart !== null && this.selectedRangeEnd !== null
        ? ` · Range ${this.selectedRangeStart + 1}-${this.selectedRangeEnd + 1}`
        : '';
    return `${channel?.label ?? 'Channel'} · Frame ${this.currentFrame + 1}/${this.frameCount} · ${currentValue.toFixed(4)} · ${timeSeconds.toFixed(2)}s${rangeLabel}`;
  }

  private getChannelGroups(): Array<{ groupId: string; label: string; channels: MotionCurveChannel[] }> {
    const groups = new Map<string, { groupId: string; label: string; channels: MotionCurveChannel[] }>();
    for (const channel of this.channels) {
      const groupId = this.getChannelGroupId(channel.id);
      const group = groups.get(groupId);
      if (group) {
        group.channels.push(channel);
        continue;
      }

      groups.set(groupId, {
        groupId,
        label: this.buildGroupLabel(channel),
        channels: [channel],
      });
    }

    return [...groups.values()];
  }

  private selectPreferredGroupId(preferredGroupId: string | null): string | null {
    const groups = this.getChannelGroups();
    if (preferredGroupId && groups.some((group) => group.groupId === preferredGroupId)) {
      return preferredGroupId;
    }

    const selectedGroupId = this.selectedChannelId ? this.getChannelGroupId(this.selectedChannelId) : null;
    if (selectedGroupId && groups.some((group) => group.groupId === selectedGroupId)) {
      return selectedGroupId;
    }

    return groups[0]?.groupId ?? null;
  }

  private syncAxisOptions(groupId: string | null, preferredAxisValue: string | null = null): void {
    this.axisSelect.innerHTML = '';
    const channels = groupId ? this.getChannelGroups().find((group) => group.groupId === groupId)?.channels ?? [] : [];

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = channels.length > 0 ? 'Select axis / DOF...' : 'No axis';
    this.axisSelect.appendChild(placeholder);

    for (const channel of channels) {
      const option = document.createElement('option');
      option.value = this.getChannelAxisValue(channel.id);
      option.textContent = this.buildAxisLabel(channel);
      this.axisSelect.appendChild(option);
    }

    const selectedAxisValue = this.selectPreferredAxisValue(channels, preferredAxisValue);
    this.axisSelect.value = selectedAxisValue ?? '';
    this.axisSelect.disabled = channels.length === 0;
  }

  private selectPreferredAxisValue(
    channels: MotionCurveChannel[],
    preferredAxisValue: string | null,
  ): string | null {
    if (preferredAxisValue && channels.some((channel) => this.getChannelAxisValue(channel.id) === preferredAxisValue)) {
      return preferredAxisValue;
    }

    if (this.selectedChannelId) {
      const selectedAxisValue = this.getChannelAxisValue(this.selectedChannelId);
      if (channels.some((channel) => this.getChannelAxisValue(channel.id) === selectedAxisValue)) {
        return selectedAxisValue;
      }
    }

    return channels[0] ? this.getChannelAxisValue(channels[0].id) : null;
  }

  private resolveSelectedChannelId(groupId: string | null, axisValue: string | null): string | null {
    if (!groupId) {
      return null;
    }

    const channels = this.getChannelGroups().find((group) => group.groupId === groupId)?.channels ?? [];
    if (channels.length === 0) {
      return null;
    }

    if (axisValue) {
      const matchedChannel = channels.find((channel) => this.getChannelAxisValue(channel.id) === axisValue);
      if (matchedChannel) {
        return matchedChannel.id;
      }
    }

    return channels[0]?.id ?? null;
  }

  private getChannelGroupId(channelId: string): string {
    const separatorIndex = channelId.indexOf(':');
    if (separatorIndex < 0) {
      return channelId;
    }

    const prefix = channelId.slice(0, separatorIndex);
    if (prefix === 'joint') {
      return channelId;
    }

    return prefix;
  }

  private getChannelAxisValue(channelId: string): string {
    const separatorIndex = channelId.indexOf(':');
    if (separatorIndex < 0) {
      return '';
    }

    if (channelId.startsWith('joint:')) {
      return 'value';
    }

    return channelId.slice(separatorIndex + 1);
  }

  private buildGroupLabel(channel: MotionCurveChannel): string {
    if (channel.kind === 'root_position') {
      return 'Root Translation';
    }

    if (channel.kind === 'root_rotation') {
      return 'Root Rotation';
    }

    return channel.label;
  }

  private buildAxisLabel(channel: MotionCurveChannel): string {
    if (channel.kind === 'joint') {
      return 'Value';
    }

    if (!channel.axis) {
      return 'Value';
    }

    if (channel.axis === 'x' || channel.axis === 'y' || channel.axis === 'z') {
      return channel.axis.toUpperCase();
    }

    return channel.axis[0]?.toUpperCase() + channel.axis.slice(1);
  }

  private setStatus(message: string): void {
    this.statusElement.textContent = message;
  }

  private render(): void {
    const width = this.canvas.width / this.dpr || 1;
    const height = this.canvas.height / this.dpr || 1;

    this.ctx.clearRect(0, 0, width, height);
    this.ctx.fillStyle = 'rgba(4, 14, 20, 0.92)';
    this.ctx.fillRect(0, 0, width, height);

    const bounds = this.getPlotBounds();
    this.drawGrid(bounds);

    if (!this.selectedChannelId || this.values.length === 0 || this.frameCount <= 0) {
      this.drawPlaceholder(width, height);
      return;
    }

    this.drawSelectedRange(bounds);
    this.drawCurve(bounds);
    this.drawCurrentFrame(bounds);
  }

  private drawPlaceholder(width: number, height: number): void {
    this.ctx.fillStyle = 'rgba(175, 208, 221, 0.78)';
    this.ctx.font = '12px "Space Grotesk", sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('Curve preview will appear here', width / 2, height / 2);
  }

  private drawGrid(bounds: PlotBounds): void {
    this.ctx.strokeStyle = 'rgba(146, 205, 236, 0.12)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();

    const verticalDivisions = 6;
    for (let index = 0; index <= verticalDivisions; index += 1) {
      const x = bounds.left + (bounds.width * index) / verticalDivisions;
      this.ctx.moveTo(x, bounds.top);
      this.ctx.lineTo(x, bounds.bottom);
    }

    const horizontalDivisions = 4;
    for (let index = 0; index <= horizontalDivisions; index += 1) {
      const y = bounds.top + (bounds.height * index) / horizontalDivisions;
      this.ctx.moveTo(bounds.left, y);
      this.ctx.lineTo(bounds.right, y);
    }

    this.ctx.stroke();
  }

  private drawCurve(bounds: PlotBounds): void {
    const { min, max } = this.getValueRange();

    this.ctx.save();
    this.ctx.strokeStyle = '#8ddfca';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    for (let frameIndex = 0; frameIndex < this.frameCount; frameIndex += 1) {
      const value = this.values[frameIndex] ?? 0;
      const x = this.frameToX(frameIndex, bounds);
      const y = this.valueToY(value, bounds, min, max);
      if (frameIndex === 0) {
        this.ctx.moveTo(x, y);
      } else {
        this.ctx.lineTo(x, y);
      }
    }
    this.ctx.stroke();

    this.ctx.fillStyle = 'rgba(234, 247, 255, 0.92)';
    this.ctx.font = '11px "Space Grotesk", sans-serif';
    this.ctx.textAlign = 'left';
    this.ctx.fillText(max.toFixed(3), 8, bounds.top + 4);
    this.ctx.fillText(min.toFixed(3), 8, bounds.bottom - 2);

    this.ctx.textAlign = 'right';
    this.ctx.fillStyle = 'rgba(175, 208, 221, 0.75)';
    this.ctx.fillText('frames', bounds.right, this.canvas.height / this.dpr - 8);
    this.ctx.restore();
  }

  private drawSelectedRange(bounds: PlotBounds): void {
    if (this.selectedRangeStart === null || this.selectedRangeEnd === null || this.frameCount <= 0) {
      return;
    }

    const startFrame = Math.max(0, Math.min(this.selectedRangeStart, this.selectedRangeEnd));
    const endFrame = Math.max(startFrame, Math.max(this.selectedRangeStart, this.selectedRangeEnd));
    const startX = this.frameToX(startFrame, bounds);
    const endX = this.frameToX(endFrame, bounds);
    const width = Math.max(endX - startX, 2);

    this.ctx.save();
    this.ctx.fillStyle = 'rgba(83, 191, 157, 0.14)';
    this.ctx.fillRect(startX, bounds.top, width, bounds.height);
    this.ctx.strokeStyle = 'rgba(131, 223, 193, 0.72)';
    this.ctx.setLineDash([5, 4]);
    this.ctx.beginPath();
    this.ctx.moveTo(startX, bounds.top);
    this.ctx.lineTo(startX, bounds.bottom);
    this.ctx.moveTo(endX, bounds.top);
    this.ctx.lineTo(endX, bounds.bottom);
    this.ctx.stroke();
    this.ctx.setLineDash([]);
    this.ctx.restore();
  }

  private drawCurrentFrame(bounds: PlotBounds): void {
    const { min, max } = this.getValueRange();
    const x = this.frameToX(this.currentFrame, bounds);
    const value = this.values[this.currentFrame] ?? 0;
    const y = this.valueToY(value, bounds, min, max);

    this.ctx.save();
    this.ctx.strokeStyle = 'rgba(255, 142, 106, 0.92)';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(x, bounds.top);
    this.ctx.lineTo(x, bounds.bottom);
    this.ctx.stroke();

    this.ctx.fillStyle = '#ff8e6a';
    this.ctx.beginPath();
    this.ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
  }

  private getValueRange(): { min: number; max: number } {
    if (this.values.length === 0) {
      return { min: -1, max: 1 };
    }

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of this.values) {
      if (value < min) {
        min = value;
      }
      if (value > max) {
        max = value;
      }
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: -1, max: 1 };
    }

    if (Math.abs(max - min) < 1e-6) {
      const padding = Math.max(Math.abs(max) * 0.15, 0.5);
      return { min: min - padding, max: max + padding };
    }

    const padding = (max - min) * 0.12;
    return {
      min: min - padding,
      max: max + padding,
    };
  }

  private getPlotBounds(): PlotBounds {
    const width = this.canvas.width / this.dpr || 1;
    const height = this.canvas.height / this.dpr || 1;
    const left = 48;
    const right = Math.max(left + 1, width - 18);
    const top = 16;
    const bottom = Math.max(top + 1, height - 28);
    return {
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  private frameToX(frameIndex: number, bounds: PlotBounds): number {
    if (this.frameCount <= 1) {
      return bounds.left;
    }
    return bounds.left + (bounds.width * frameIndex) / Math.max(this.frameCount - 1, 1);
  }

  private frameFromX(x: number, bounds: PlotBounds): number {
    if (this.frameCount <= 1) {
      return 0;
    }
    const t = (x - bounds.left) / Math.max(bounds.width, 1);
    return Math.max(0, Math.min(this.frameCount - 1, Math.round(t * (this.frameCount - 1))));
  }

  private valueToY(value: number, bounds: PlotBounds, min?: number, max?: number): number {
    const range = min !== undefined && max !== undefined ? { min, max } : this.getValueRange();
    const normalized = (value - range.min) / Math.max(range.max - range.min, 1e-6);
    return bounds.bottom - normalized * bounds.height;
  }

  private yToValue(y: number, bounds: PlotBounds): number {
    const { min, max } = this.getValueRange();
    const normalized = (bounds.bottom - y) / Math.max(bounds.height, 1);
    return min + normalized * (max - min);
  }

  private isInsidePlot(x: number, y: number, bounds: PlotBounds): boolean {
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
  }

  private beginRangeSelection(pointerId: number, frameIndex: number): void {
    this.rangeSelectingPointerId = pointerId;
    this.rangeSelectionAnchorFrame = frameIndex;
    this.canvas.setPointerCapture(pointerId);
    this.updateSelectedRange(frameIndex, frameIndex, true);
  }

  private updateSelectedRange(
    startFrame: number | null,
    endFrame: number | null,
    emitSelection: boolean,
  ): void {
    if (startFrame === null || endFrame === null || this.frameCount <= 0) {
      this.selectedRangeStart = null;
      this.selectedRangeEnd = null;
    } else {
      const normalizedStart = Math.max(
        0,
        Math.min(this.frameCount - 1, Math.floor(Math.min(startFrame, endFrame))),
      );
      const normalizedEnd = Math.max(
        normalizedStart,
        Math.min(this.frameCount - 1, Math.floor(Math.max(startFrame, endFrame))),
      );
      this.selectedRangeStart = normalizedStart;
      this.selectedRangeEnd = normalizedEnd;
    }

    this.setStatus(this.buildStatusMessage());
    this.render();
    if (emitSelection) {
      this.onRangeSelected?.(this.selectedRangeStart, this.selectedRangeEnd);
    }
  }

  private getCanvasPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }
}
