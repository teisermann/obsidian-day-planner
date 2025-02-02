import {
  Component,
  FileView,
  MarkdownRenderer,
  Plugin,
  WorkspaceLeaf,
} from "obsidian";
import { getDateFromFile } from "obsidian-daily-notes-interface";
import { DataArray, getAPI, STask } from "obsidian-dataview";
import {
  derived,
  get,
  readable,
  Readable,
  writable,
  Writable,
} from "svelte/store";

import { obsidianContext, viewTypeTimeline, viewTypeWeekly } from "./constants";
import { settings } from "./global-store/settings";
import { visibleDayInTimeline } from "./global-store/visible-day-in-timeline";
import { visibleDays } from "./global-store/visible-days";
import { getScheduledDay } from "./service/dataview-facade";
import { ObsidianFacade } from "./service/obsidian-facade";
import { PlanEditor } from "./service/plan-editor";
import { DayPlannerSettings, defaultSettings } from "./settings";
import { TasksForDay } from "./types";
import {
  EditContext,
  useEditContext,
} from "./ui/hooks/use-edit/use-edit-context";
import { DayPlannerSettingsTab } from "./ui/settings-tab";
import { StatusBar } from "./ui/status-bar";
import TimelineView from "./ui/timeline-view";
import WeeklyView from "./ui/weekly-view";
import { createDailyNoteIfNeeded } from "./util/daily-notes";
import { debounceWithDelay } from "./util/debounce-with-delay";
import { mapToTasksForDay } from "./util/get-tasks-for-day";
import { isToday } from "./util/moment";
import { getEmptyTasksForDay } from "./util/tasks-utils";

export default class DayPlanner extends Plugin {
  settings: () => DayPlannerSettings;
  private settingsStore: Writable<DayPlannerSettings>;
  private statusBar: StatusBar;
  private obsidianFacade: ObsidianFacade;
  private planEditor: PlanEditor;
  private dataviewTasks: Readable<DataArray<STask>>;
  private readonly dataviewLoaded = writable(false);
  private readonly fileSyncInProgress = writable(false);
  private editContext: Readable<EditContext>;

  async onload() {
    await this.initSettingsStore();
    this.initDataviewTasks();

    this.obsidianFacade = new ObsidianFacade(this.app);
    this.planEditor = new PlanEditor(this.settings, this.obsidianFacade);

    this.registerCommands();

    this.addRibbonIcon("calendar-range", "Timeline", this.initTimelineLeaf);
    this.addSettingTab(new DayPlannerSettingsTab(this, this.settingsStore));
    this.statusBar = new StatusBar(
      this.settings,
      this.addStatusBarItem(),
      this.initTimelineLeaf,
    );

    this.register(this.dataviewTasks.subscribe(this.updateStatusBar));

    this.registerViews();
    this.app.workspace.on("active-leaf-change", this.handleActiveLeafChanged);
  }

  private getAllTasks() {
    const source = this.settings().dataviewSource;
    return this.refreshTasks(source);
  }

  private refreshTasks = (source: string) => {
    const dataview = getAPI(this.app);

    if (!dataview) {
      return [];
    }

    this.dataviewLoaded.set(true);

    performance.mark("query-start");
    const result = dataview.pages(source).file.tasks;
    performance.mark("query-end");

    const measure = performance.measure(
      "query-time",
      "query-start",
      "query-end",
    );

    console.debug(
      `obsidian-day-planner:
  source: "${source}"
  took: ${measure.duration} ms`,
    );

    return result;
  };

  private initDataviewTasks() {
    this.dataviewTasks = readable(this.getAllTasks(), (set) => {
      const [updateTasks, delayUpdateTasks] = debounceWithDelay(() => {
        set(this.getAllTasks());
      }, 1000);

      this.app.metadataCache.on(
        // @ts-expect-error
        "dataview:metadata-change",
        updateTasks,
      );
      document.addEventListener("keydown", delayUpdateTasks);

      const source = derived(this.settingsStore, ($settings) => {
        return $settings.dataviewSource;
      });

      const unsubscribeFromSettings = source.subscribe(() => {
        updateTasks();
      });

      return () => {
        this.app.metadataCache.off("dataview:metadata-change", updateTasks);
        document.removeEventListener("keydown", delayUpdateTasks);
        unsubscribeFromSettings();
      };
    });
  }

  private handleActiveLeafChanged = ({ view }: WorkspaceLeaf) => {
    if (!(view instanceof FileView) || !view.file) {
      return;
    }

    const dayUserSwitchedTo = getDateFromFile(view.file, "day");

    if (dayUserSwitchedTo?.isSame(get(visibleDayInTimeline), "day")) {
      return;
    }

    if (!dayUserSwitchedTo) {
      if (isToday(get(visibleDayInTimeline))) {
        visibleDayInTimeline.set(window.moment());
      }

      return;
    }

    visibleDayInTimeline.set(dayUserSwitchedTo);
  };

  private registerCommands() {
    this.addCommand({
      id: "show-day-planner-timeline",
      name: "Show the Day Planner Timeline",
      callback: async () => await this.initTimelineLeaf(),
    });

    this.addCommand({
      id: "show-weekly-view",
      name: "Show the Week Planner",
      callback: this.initWeeklyLeaf,
    });

    this.addCommand({
      id: "show-day-planner-today-note",
      name: "Open today's Day Planner",
      callback: async () =>
        this.app.workspace
          .getLeaf(false)
          .openFile(await createDailyNoteIfNeeded(window.moment())),
    });

    this.addCommand({
      id: "insert-planner-heading-at-cursor",
      name: "Insert Planner Heading at Cursor",
      editorCallback: (editor) =>
        editor.replaceSelection(this.planEditor.createPlannerHeading()),
    });
  }

  private async initSettingsStore() {
    settings.set({ ...defaultSettings, ...(await this.loadData()) });

    this.register(
      settings.subscribe(async (newValue) => {
        await this.saveData(newValue);
      }),
    );

    this.settingsStore = settings;
    this.settings = () => get(settings);
  }

  async onunload() {
    await this.detachLeavesOfType(viewTypeTimeline);
    await this.detachLeavesOfType(viewTypeWeekly);
  }

  private updateStatusBar = async (dataviewTasks: DataArray<STask>) => {
    // const today = window.moment();
    //
    // await this.statusBar.update(
    //   getTasksForDay(today, dataviewTasks, { ...this.settings() }),
    // );
  };

  initWeeklyLeaf = async () => {
    await this.detachLeavesOfType(viewTypeWeekly);
    await this.app.workspace.getLeaf(false).setViewState({
      type: viewTypeWeekly,
      active: true,
    });
  };

  initTimelineLeaf = async () => {
    await this.detachLeavesOfType(viewTypeTimeline);
    await this.app.workspace.getRightLeaf(false).setViewState({
      type: viewTypeTimeline,
      active: true,
    });
    this.app.workspace.rightSplit.expand();
  };

  private async detachLeavesOfType(type: string) {
    // Although detatch() is synchronous, without wrapping into a promise, weird things happen:
    // - when re-initializing the weekly view, it gets deleted every other time instead of getting re-created
    // - or the tabs get hidden
    return Promise.all(
      this.app.workspace.getLeavesOfType(type).map((leaf) => leaf.detach()),
    );
  }

  renderMarkdown = (el: HTMLElement, text: string) => {
    const loader = new Component();

    el.empty();

    MarkdownRenderer.render(this.app, text, el, "", loader);

    loader.load();

    return () => loader.unload();
  };

  private registerViews() {
    const visibleTasks = derived(
      [visibleDays, this.dataviewTasks, this.settingsStore],
      ([$visibleDays, $dataviewTasks, $settings]) => {
        const dayToSTasksLookup: Record<string, STask[]> = Object.fromEntries(
          $dataviewTasks
            .groupBy(getScheduledDay)
            .map(({ key, rows }) => [key, rows.array()])
            .array(),
        );

        return $visibleDays.reduce<Record<string, TasksForDay>>(
          (result, day) => {
            const key = day.format("YYYY-MM-DD");
            const sTasksForDay = dayToSTasksLookup[key];

            if (sTasksForDay) {
              result[key] = mapToTasksForDay(day, sTasksForDay, $settings);
            } else {
              result[key] = getEmptyTasksForDay();
            }

            return result;
          },
          {},
        );
      },
    );

    this.editContext = derived(
      [this.settingsStore, visibleTasks],
      ([$settings, $visibleTasks]) => {
        return useEditContext({
          obsidianFacade: this.obsidianFacade,
          onUpdate: this.planEditor.syncTasksWithFile,
          // todo: remove
          fileSyncInProgress: this.fileSyncInProgress,
          settings: $settings,
          visibleTasks: $visibleTasks,
        });
      },
    );

    const componentContext = new Map([
      [
        obsidianContext,
        {
          // todo: once editContext is lifted up, we don't need half of this stuff
          obsidianFacade: this.obsidianFacade,
          initWeeklyView: this.initWeeklyLeaf,
          refreshTasks: this.refreshTasks,
          dataviewLoaded: this.dataviewLoaded,
          renderMarkdown: this.renderMarkdown,
          editContext: this.editContext,
        },
      ],
    ]);

    this.registerView(
      viewTypeTimeline,
      (leaf: WorkspaceLeaf) =>
        new TimelineView(leaf, this.settings, componentContext),
    );

    this.registerView(
      viewTypeWeekly,
      (leaf: WorkspaceLeaf) =>
        new WeeklyView(leaf, this.settings, componentContext),
    );
  }
}
