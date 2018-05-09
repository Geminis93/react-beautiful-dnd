// @flow
import invariant from 'tiny-invariant';
import { type Position } from 'css-box-model';
import * as timings from '../../debug/timings';
import getViewport from '../../view/window/get-viewport';
import type { BulkReplaceArgs } from '../action-creators';
import type {
  DraggableId,
  DroppableId,
  DraggableDimension,
  DroppableDimension,
  DroppableDescriptor,
  DraggableDescriptor,
  ScrollOptions,
  Viewport,
  DroppableDimensionMap,
  DraggableDimensionMap,
  DimensionMap,
} from '../../types';
import type {
  Entries,
  DraggableEntry,
  DroppableEntry,
  Collection,
} from './dimension-marshal-types';

type CollectOptions = {|
  collection: Collection,
  includeCritical: boolean,
|}

export type Collector = {|
  stop: () => void,
  collect: (options: CollectOptions) => void,
|}

type Args = {|
  getEntries: () => Entries,
  bulkReplace: (args: BulkReplaceArgs) => void,
|}

export default ({
  bulkReplace,
  getEntries,
}: Args): Collector => {
  let frameId: ?AnimationFrameID = null;

  const collectFromDOM = (windowScroll: Position, options: CollectOptions): DimensionMap => {
    const { collection, includeCritical } = options;
    const entries: Entries = getEntries();
    const home: DroppableDescriptor = collection.critical.droppable;
    const dragging: DraggableDescriptor = collection.critical.draggable;
    const scrollOptions: ScrollOptions = collection.scrollOptions;

    // 1. Figure out what we need to collect

    const droppables: DroppableEntry[] = Object.keys(entries.droppables)
      .map((id: DroppableId): DroppableEntry => entries.droppables[id])
      // Exclude things of the wrong type
      .filter((entry: DroppableEntry): boolean => entry.descriptor.type === home.type)
      // Exclude the critical droppable if needed
      .filter((entry: DroppableEntry): boolean => {
        if (includeCritical) {
          return true;
        }

        return entry.descriptor.id !== home.id;
      });

    const draggables: DraggableEntry[] = Object.keys(entries.draggables)
      .map((id: DraggableId): DraggableEntry => entries.draggables[id])
      // Exclude things of the wrong type
      .filter((entry: DraggableEntry): boolean => {
        const parent: ?DroppableEntry = entries.droppables[entry.descriptor.droppableId];

        // This should never happen
        // but it is better to print this information and continue on
        if (!parent) {
          console.warn(`
            Orphan Draggable found [id: ${entry.descriptor.id}] which says
            it belongs to unknown Droppable ${entry.descriptor.droppableId}
          `);
          return false;
        }

        return parent.descriptor.type === home.type;
      })
      .filter((entry: DraggableEntry): boolean => {
        // Exclude the critical draggable if needed
        if (includeCritical) {
          return true;
        }
        return entry.descriptor.id !== dragging.id;
      });

    // 2. Tell all droppables to show their placeholders

    droppables.forEach((entry: DroppableEntry) => entry.callbacks.hidePlaceholder());

    // 3. Do the collection from the DOM

    const droppableDimensions: DroppableDimensionMap = droppables
      .map((entry: DroppableEntry): DroppableDimension =>
        entry.callbacks.getDimensionAndWatchScroll(windowScroll, scrollOptions))
      .reduce((previous: DroppableDimensionMap, current: DroppableDimension) => {
        previous[current.descriptor.id] = current;
        return previous;
      }, {});

    const draggableDimensions: DraggableDimensionMap = draggables
      .map((entry: DraggableEntry): DraggableDimension => entry.getDimension(windowScroll))
      .reduce((previous: DraggableDimensionMap, current: DraggableDimension) => {
        previous[current.descriptor.id] = current;
        return previous;
      }, {});

    // 4. Tell all the droppables to show their placeholders
    droppables.forEach((entry: DroppableEntry) => entry.callbacks.showPlaceholder());

    return {
      droppables: droppableDimensions,
      draggables: draggableDimensions,
    };
  };

  const abortFrame = () => {
    if (!frameId) {
      return;
    }
    cancelAnimationFrame(frameId);
    frameId = null;
  };

  const collect = (options: CollectOptions) => {
    abortFrame();

    // Perform DOM collection in next frame
    frameId = requestAnimationFrame(() => {
      timings.start('DOM collection');
      const viewport: Viewport = getViewport();
      const dimensions: DimensionMap = collectFromDOM(viewport.scroll, options);
      timings.finish('DOM collection');

      // Perform publish in next frame
      frameId = requestAnimationFrame(() => {
        timings.start('Bulk dimension publish');
        bulkReplace({
          dimensions,
          viewport,
          shouldReplaceCritical: options.includeCritical,
        });
        timings.finish('Bulk dimension publish');

        frameId = null;
      });
    });
  };

  const stop = () => {
    abortFrame();
  };

  return {
    collect,
    stop,
  };
};