export interface DropHandlerOptions {
  onDrop: (dataTransfer: DataTransfer) => Promise<void> | void;
  onDragStateChange: (isDragging: boolean) => void;
}

function isFileDragEvent(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes('Files'));
}

export function registerDropHandlers(
  target: Document | HTMLElement,
  options: DropHandlerOptions,
): () => void {
  let dragCounter = 0;

  const preventDefaults = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleDragEnter = (event: Event): void => {
    const dragEvent = event as DragEvent;
    if (!isFileDragEvent(dragEvent)) {
      return;
    }

    preventDefaults(event);
    dragCounter += 1;
    options.onDragStateChange(true);
  };

  const handleDragOver = (event: Event): void => {
    const dragEvent = event as DragEvent;
    if (!isFileDragEvent(dragEvent)) {
      return;
    }

    preventDefaults(event);
    if (dragEvent.dataTransfer) {
      dragEvent.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDragLeave = (event: Event): void => {
    const dragEvent = event as DragEvent;
    if (!isFileDragEvent(dragEvent)) {
      return;
    }

    preventDefaults(event);
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) {
      options.onDragStateChange(false);
    }
  };

  const handleDrop = (event: Event): void => {
    const dragEvent = event as DragEvent;
    if (!isFileDragEvent(dragEvent)) {
      return;
    }

    preventDefaults(event);
    dragCounter = 0;
    options.onDragStateChange(false);

    if (dragEvent.dataTransfer) {
      void options.onDrop(dragEvent.dataTransfer);
    }
  };

  target.addEventListener('dragenter', handleDragEnter);
  target.addEventListener('dragover', handleDragOver);
  target.addEventListener('dragleave', handleDragLeave);
  target.addEventListener('drop', handleDrop);

  return () => {
    target.removeEventListener('dragenter', handleDragEnter);
    target.removeEventListener('dragover', handleDragOver);
    target.removeEventListener('dragleave', handleDragLeave);
    target.removeEventListener('drop', handleDrop);
  };
}
