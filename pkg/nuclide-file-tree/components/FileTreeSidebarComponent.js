/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */
/* global HTMLElement */

import type {FileChangeStatusValue} from '../../nuclide-vcs-base';
import type {NuclideUri} from 'nuclide-commons/nuclideUri';
import type {ShowUncommittedChangesKindValue} from '../lib/Constants';
import type {WorkingSetsStore} from '../../nuclide-working-sets/lib/WorkingSetsStore.js';

import {Emitter} from 'atom';
import * as React from 'react';
import ReactDOM from 'react-dom';
import observePaneItemVisibility from 'nuclide-commons-atom/observePaneItemVisibility';
import addTooltip from 'nuclide-commons-ui/addTooltip';
import {Observable, Subject} from 'rxjs';
import {ShowUncommittedChangesKind} from '../lib/Constants';
import FileTreeHelpers from '../lib/FileTreeHelpers';

import {
  REVEAL_FILE_ON_SWITCH_SETTING,
  SHOW_OPEN_FILE_CONFIG_KEY,
  SHOW_UNCOMMITTED_CHANGES_CONFIG_KEY,
  SHOW_UNCOMMITTED_CHANGES_KIND_CONFIG_KEY,
  WORKSPACE_VIEW_URI,
} from '../lib/Constants';
import {repositoryForPath} from '../../nuclide-vcs-base';
import {
  LoadingSpinner,
  LoadingSpinnerSizes,
} from 'nuclide-commons-ui/LoadingSpinner';
import {VirtualizedFileTree} from './VirtualizedFileTree';
import {Icon} from 'nuclide-commons-ui/Icon';
import FileTreeSideBarFilterComponent from './FileTreeSideBarFilterComponent';
import {FileTreeToolbarComponent} from './FileTreeToolbarComponent';
import {OpenFilesListComponent} from './OpenFilesListComponent';
import {LockableHeight} from './LockableHeightComponent';
import FileTreeActions from '../lib/FileTreeActions';
import {FileTreeStore} from '../lib/FileTreeStore';
import {MultiRootChangedFilesView} from '../../nuclide-ui/MultiRootChangedFilesView';
import {PanelComponentScroller} from 'nuclide-commons-ui/PanelComponentScroller';
import {ResizeObservable} from 'nuclide-commons-ui/observable-dom';
import {toggle, compact} from 'nuclide-commons/observable';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {observableFromSubscribeFunction} from 'nuclide-commons/event';
import {cacheWhileSubscribed} from 'nuclide-commons/observable';
import {Section} from 'nuclide-commons-ui/Section';
import featureConfig from 'nuclide-commons-atom/feature-config';
import {goToLocation} from 'nuclide-commons-atom/go-to-location';
import nuclideUri from 'nuclide-commons/nuclideUri';
import {track} from '../../nuclide-analytics';
import invariant from 'assert';
import {remote} from 'electron';
import {showMenuForEvent} from 'nuclide-commons-atom/ContextMenu';
import Immutable from 'immutable';
import {createSelector} from 'reselect';

type State = {|
  shouldRenderToolbar: boolean,
  scrollerHeight: number,
  scrollerWidth: number,
  showOpenFiles: boolean,
  showUncommittedChanges: boolean,
  showUncommittedChangesKind: ShowUncommittedChangesKindValue,
  openFilesUris: Array<NuclideUri>,
  modifiedUris: Array<NuclideUri>,
  activeUri: ?NuclideUri,
  hidden: boolean,
  uncommittedFileChanges: Immutable.Map<
    NuclideUri,
    Immutable.Map<NuclideUri, FileChangeStatusValue>,
  >,
  isCalculatingChanges: boolean,
  path: string,
  title: string,
  isFileTreeHovered: boolean,
  workingSetsStore: ?WorkingSetsStore,
  filter: string,
  filterFound: boolean,
  foldersExpanded: boolean,
  uncommittedChangesExpanded: boolean,
  openFilesExpanded: boolean,
|};

export default class FileTreeSidebarComponent extends React.Component<
  mixed,
  State,
> {
  _actions: FileTreeActions;
  _store: FileTreeStore;
  _emitter: Emitter;
  _disposables: UniversalDisposable;
  _showOpenConfigValues: Observable<boolean>;
  _showUncommittedConfigValue: Observable<boolean>;
  _showUncommittedKindConfigValue: Observable<ShowUncommittedChangesKindValue>;
  _scrollerElements: Subject<?HTMLElement>;
  _scrollerScrollTop: number;
  // $FlowFixMe flow does not recognize VirtualizedFileTree as React component
  _scrollerRef: ?React.ElementRef<VirtualizedFileTree>;

  constructor() {
    super();

    this._actions = FileTreeActions.getInstance();
    this._store = FileTreeStore.getInstance();
    this._emitter = new Emitter();
    this.state = {
      hidden: false,
      shouldRenderToolbar: false,
      scrollerHeight: window.innerHeight,
      scrollerWidth: this.getPreferredWidth(),
      showOpenFiles: true,
      showUncommittedChanges: true,
      showUncommittedChangesKind: 'Uncommitted changes',
      openFilesUris: [],
      modifiedUris: [],
      activeUri: null,
      uncommittedFileChanges: Immutable.Map(),
      isCalculatingChanges: false,
      path: 'No Current Working Directory',
      title: 'File Tree',
      isFileTreeHovered: false,
      workingSetsStore: this._store.getWorkingSetsStore(),
      filter: this._store.getFilter(),
      filterFound: this._store.getFilterFound(),
      foldersExpanded: this._store.foldersExpanded,
      uncommittedChangesExpanded: this._store.uncommittedChangesExpanded,
      openFilesExpanded: this._store.openFilesExpanded,
    };
    this._showOpenConfigValues = cacheWhileSubscribed(
      (featureConfig.observeAsStream(SHOW_OPEN_FILE_CONFIG_KEY): Observable<
        any,
      >),
    );
    this._showUncommittedConfigValue = cacheWhileSubscribed(
      (featureConfig.observeAsStream(
        SHOW_UNCOMMITTED_CHANGES_CONFIG_KEY,
      ): Observable<any>),
    );
    this._showUncommittedKindConfigValue = FileTreeHelpers.observeUncommittedChangesKindConfigKey();

    this._scrollerElements = new Subject();
    this._scrollerScrollTop = 0;
    this._scrollerRef = null;
    this._disposables = new UniversalDisposable(
      this._emitter,
      this._subscribeToResizeEvents(),
    );
  }

  componentDidMount(): void {
    const componentDOMNode = ReactDOM.findDOMNode(this);
    invariant(componentDOMNode instanceof HTMLElement);

    this._processExternalUpdate();

    this._disposables.add(
      this._store.subscribe(this._processExternalUpdate),
      observeAllModifiedStatusChanges()
        .let(toggle(this._showOpenConfigValues))
        .subscribe(() => this._setModifiedUris()),
      this._monitorActiveUri(),
      this._showOpenConfigValues.subscribe(showOpenFiles =>
        this.setState({showOpenFiles}),
      ),
      this._showUncommittedConfigValue.subscribe(showUncommittedChanges =>
        this.setState({showUncommittedChanges}),
      ),
      this._showUncommittedKindConfigValue.subscribe(
        showUncommittedChangesKind =>
          this.setState({showUncommittedChangesKind}),
      ),
      // Customize the context menu to remove items that match the 'atom-pane' selector.
      Observable.fromEvent(componentDOMNode, 'contextmenu')
        .switchMap(event => {
          if (event.button !== 2) {
            return Observable.never();
          }

          event.preventDefault();
          event.stopPropagation();

          // Find all the item sets that match the 'atom-pane' selector. We're going to remove these
          // by changing their selector.
          const paneItemSets = atom.contextMenu.itemSets.filter(
            itemSet => itemSet.selector === 'atom-pane',
          );
          // Override the selector while we get the template.
          paneItemSets.forEach(itemSet => {
            itemSet.selector = 'do-not-match-anything';
          });
          const menuTemplate = atom.contextMenu.templateForEvent(event);
          paneItemSets.forEach(itemSet => {
            itemSet.selector = 'atom-pane';
          });
          // Wrap the disposable in an observable. This way we don't have to manually track these
          // disposables, they'll be managed for us.
          return Observable.create(() => showMenuForEvent(event, menuTemplate));
        })
        .subscribe(),
      observePaneItemVisibility(this).subscribe(visible => {
        this.didChangeVisibility(visible);
      }),
    );
  }

  componentWillUnmount(): void {
    this._disposables.dispose();
  }

  componentDidUpdate(prevProps: mixed, prevState: State): void {
    if (prevState.hidden && !this.state.hidden) {
      // If "Reveal File on Switch" is enabled, ensure the scroll position is synced to where the
      // user expects when the side bar shows the file tree.
      if (featureConfig.get(REVEAL_FILE_ON_SWITCH_SETTING)) {
        atom.commands.dispatch(
          atom.views.getView(atom.workspace),
          'tree-view:reveal-active-file',
        );
      }
      this._actions.clearFilter();
    }
  }

  _subscribeToResizeEvents(): rxjs$Subscription {
    const scrollerRects = this._scrollerElements.switchMap(scroller => {
      if (scroller == null) {
        return Observable.empty();
      }

      return new ResizeObservable(scroller).map(arr => {
        if (arr.length === 0) {
          return null;
        }

        return arr[arr.length - 1].contentRect;
      });
    });

    return scrollerRects
      .let(compact)
      .subscribe(rect =>
        this.setState({scrollerHeight: rect.height, scrollerWidth: rect.width}),
      );
  }

  _setScrollerRef = (node: React$ElementRef<any>): void => {
    this._scrollerRef = node;
    if (node == null) {
      this._scrollerElements.next(null);
      return;
    }

    const scroller = ReactDOM.findDOMNode(node);
    if (scroller == null) {
      this._scrollerElements.next(null);
      return;
    }

    invariant(scroller instanceof HTMLElement);
    this._scrollerElements.next(scroller);
  };

  _handleFocus = (event: SyntheticEvent<>): void => {
    if (event.target === ReactDOM.findDOMNode(this)) {
      this.focus();
    }
  };

  render() {
    let toolbar;
    const workingSetsStore = this.state.workingSetsStore;
    if (this.state.shouldRenderToolbar && workingSetsStore != null) {
      toolbar = (
        <div className="nuclide-file-tree-fixed">
          <FileTreeSideBarFilterComponent
            key="filter"
            filter={this.state.filter}
            found={this.state.filterFound}
          />
          {this.state.foldersExpanded && (
            <FileTreeToolbarComponent
              key="toolbar"
              workingSetsStore={workingSetsStore}
            />
          )}
        </div>
      );
    }

    let uncommittedChangesSection;
    let uncommittedChangesHeadline;
    if (this.state.showUncommittedChanges) {
      const uncommittedChangesList = (
        <div className="nuclide-file-tree-sidebar-uncommitted-changes">
          <MultiRootChangedFilesView
            analyticsSurface="file-tree-uncommitted-changes"
            commandPrefix="file-tree-sidebar"
            enableInlineActions={true}
            fileStatuses={this._getFilteredUncommittedFileChanges(this.state)}
            selectedFile={this.state.activeUri}
            hideEmptyFolders={true}
            onFileChosen={this._onFileChosen}
            openInDiffViewOption={true}
          />
        </div>
      );

      const showDropdown = Array.from(
        this.state.uncommittedFileChanges.keys(),
      ).some(path => {
        const repo = repositoryForPath(path);
        return repo != null && repo.getType() === 'hg';
      });

      const dropdownIcon = !showDropdown ? null : (
        <Icon
          icon="triangle-down"
          className="nuclide-file-tree-toolbar-fader nuclide-ui-dropdown-icon"
          onClick={this._handleUncommittedChangesKindDownArrow}
        />
      );

      const dropdownTooltip = `<div style="text-align: left;">
This section shows the file changes you've made:<br />
<br />
<b>UNCOMMITTED</b><br />
Just the changes that you have yet to amend/commit.<br />
<br />
<b>HEAD</b><br />
Just the changes that you've already amended/committed.<br />
<br />
<b>STACK</b><br />
All the changes across your entire stacked diff.
</div>`;

      const calculatingChangesSpinner = !this.state
        .isCalculatingChanges ? null : (
        <span className="nuclide-file-tree-spinner">
          &nbsp;
          <LoadingSpinner
            className="inline-block"
            size={LoadingSpinnerSizes.EXTRA_SMALL}
          />
        </span>
      );

      uncommittedChangesHeadline = (
        // eslint-disable-next-line nuclide-internal/jsx-simple-callback-refs
        <span ref={addTooltip({title: dropdownTooltip})}>
          <span className="nuclide-dropdown-label-text-wrapper">
            {this.state.showUncommittedChangesKind.toUpperCase()}
          </span>
          {dropdownIcon}
          {calculatingChangesSpinner}
        </span>
      );

      uncommittedChangesSection = (
        <div
          className="nuclide-file-tree-uncommitted-changes-container"
          data-show-uncommitted-changes-kind={
            this.state.showUncommittedChangesKind
          }>
          <Section
            className="nuclide-file-tree-section-caption"
            collapsable={true}
            collapsed={!this.state.uncommittedChangesExpanded}
            headline={uncommittedChangesHeadline}
            onChange={this._handleUncommittedFilesExpandedChange}
            size="small">
            <PanelComponentScroller>
              {uncommittedChangesList}
            </PanelComponentScroller>
          </Section>
        </div>
      );
    }

    let openFilesSection = null;
    let openFilesList = null;
    if (this.state.showOpenFiles && this.state.openFilesUris.length > 0) {
      if (this.state.openFilesExpanded) {
        openFilesList = (
          <OpenFilesListComponent
            uris={this.state.openFilesUris}
            modifiedUris={this.state.modifiedUris}
            activeUri={this.state.activeUri}
          />
        );
      }
      openFilesSection = (
        <LockableHeight isLocked={this.state.isFileTreeHovered}>
          <Section
            className="nuclide-file-tree-section-caption nuclide-file-tree-open-files-section"
            collapsable={true}
            collapsed={!this.state.openFilesExpanded}
            headline="OPEN FILES"
            onChange={this._handleOpenFilesExpandedChange}
            size="small">
            {openFilesList}
          </Section>
        </LockableHeight>
      );
    }

    let foldersCaption;
    if (uncommittedChangesSection != null || openFilesSection != null) {
      foldersCaption = (
        <Section
          className="nuclide-file-tree-section-caption"
          headline="FOLDERS"
          collapsable={true}
          collapsed={!this.state.foldersExpanded}
          onChange={this._handleFoldersExpandedChange}
          size="small"
        />
      );
    }

    // Include `tabIndex` so this component can be focused by calling its native `focus` method.
    return (
      <div
        className="nuclide-file-tree-toolbar-container"
        onFocus={this._handleFocus}
        tabIndex={0}>
        {uncommittedChangesSection}
        {openFilesSection}
        {foldersCaption}
        {toolbar}
        {this.state.foldersExpanded && (
          <VirtualizedFileTree
            ref={this._setScrollerRef}
            onMouseEnter={this._handleFileTreeHovered}
            onMouseLeave={this._handleFileTreeUnhovered}
            onScroll={this._handleScroll}
            height={this.state.scrollerHeight}
            width={this.state.scrollerWidth}
            initialScrollTop={this._scrollerScrollTop}
          />
        )}
      </div>
    );
  }

  _handleFileTreeHovered = () => {
    this.setState({isFileTreeHovered: true});
  };

  _handleFileTreeUnhovered = () => {
    this.setState({isFileTreeHovered: false});
  };

  _processExternalUpdate = (): void => {
    const shouldRenderToolbar = !this._store.roots.isEmpty();
    const openFilesUris = this._store
      .getOpenFilesWorkingSet()
      .getAbsoluteUris();
    const uncommittedFileChanges = this._store.getFileChanges();
    const isCalculatingChanges = this._store.getIsCalculatingChanges();
    const title = this.getTitle();
    const path = this.getPath();
    const workingSetsStore = this._store.getWorkingSetsStore();
    const filter = this._store.getFilter();
    const filterFound = this._store.getFilterFound();
    const foldersExpanded = this._store.foldersExpanded;
    const uncommittedChangesExpanded = this._store.uncommittedChangesExpanded;
    const openFilesExpanded = this._store.openFilesExpanded;

    this.setState({
      shouldRenderToolbar,
      openFilesUris,
      uncommittedFileChanges,
      isCalculatingChanges,
      title,
      path,
      workingSetsStore,
      filter,
      filterFound,
      foldersExpanded,
      uncommittedChangesExpanded,
      openFilesExpanded,
    });

    if (title !== this.state.title || path !== this.state.path) {
      this._emitter.emit('did-change-title', title);
      this._emitter.emit('did-change-path', path);
    }
  };

  _onFileChosen(filePath: NuclideUri): void {
    track('filetree-uncommitted-file-changes-file-open');
    goToLocation(filePath);
  }

  _handleFoldersExpandedChange = (isCollapsed: boolean): void => {
    if (isCollapsed) {
      this.setState({isFileTreeHovered: false});
    }
    this._actions.setFoldersExpanded(!isCollapsed);
  };

  _handleOpenFilesExpandedChange = (isCollapsed: boolean): void => {
    this._actions.setOpenFilesExpanded(!isCollapsed);
  };

  _handleUncommittedFilesExpandedChange = (isCollapsed: boolean): void => {
    track('filetree-uncommitted-file-changes-toggle');
    this._actions.setUncommittedChangesExpanded(!isCollapsed);
  };

  _handleUncommittedChangesKindDownArrow = (
    event: SyntheticMouseEvent<>,
  ): void => {
    invariant(remote != null);
    const menu = new remote.Menu();
    for (const enumKey in ShowUncommittedChangesKind) {
      const kind: ShowUncommittedChangesKindValue =
        ShowUncommittedChangesKind[enumKey];
      const menuItem = new remote.MenuItem({
        type: 'checkbox',
        checked: this.state.showUncommittedChangesKind === kind,
        label: kind,
        click: () => {
          this._handleShowUncommittedChangesKindChange(kind);
        },
      });
      menu.append(menuItem);
    }
    menu.popup({x: event.clientX, y: event.clientY});
    event.stopPropagation();
  };

  _handleShowUncommittedChangesKindChange(
    showUncommittedChangesKind: ShowUncommittedChangesKindValue,
  ): void {
    switch (showUncommittedChangesKind) {
      case ShowUncommittedChangesKind.UNCOMMITTED:
        track('filetree-changes-kind-uncommitted');
        break;
      case ShowUncommittedChangesKind.HEAD:
        track('filetree-changes-kind-head');
        break;
      case ShowUncommittedChangesKind.STACK:
        track('filetree-changes-kind-stack');
        break;
    }
    featureConfig.set(
      SHOW_UNCOMMITTED_CHANGES_KIND_CONFIG_KEY,
      showUncommittedChangesKind,
    );
  }

  _setModifiedUris(): void {
    const modifiedUris = getCurrentBuffers()
      .filter(buffer => buffer.isModified())
      .map(buffer => buffer.getPath() || '')
      .filter(path => path !== '');

    this.setState({modifiedUris});
  }

  _monitorActiveUri(): IDisposable {
    const activeEditors = observableFromSubscribeFunction(
      atom.workspace.observeActiveTextEditor.bind(atom.workspace),
    );

    return new UniversalDisposable(
      activeEditors
        .debounceTime(100)
        .let(toggle(this._showOpenConfigValues))
        .subscribe(editor => {
          if (
            editor == null ||
            typeof editor.getPath !== 'function' ||
            editor.getPath() == null
          ) {
            this.setState({activeUri: null});
            return;
          }

          this.setState({activeUri: editor.getPath()});
        }),
    );
  }

  _handleScroll = (scrollTop: number): void => {
    // Do not store in state to not cause extra rendering loops on update
    this._scrollerScrollTop = scrollTop;
  };

  _getFilteredUncommittedFileChanges = createSelector(
    [(state: State) => state.uncommittedFileChanges],
    filterMultiRootFileChanges,
  );

  isFocused(): boolean {
    if (this._scrollerRef == null) {
      return false;
    }

    const el = ReactDOM.findDOMNode(this._scrollerRef);
    if (el == null) {
      return false;
    }
    return el.contains(document.activeElement);
  }

  focus(): void {
    if (this._scrollerRef == null) {
      return;
    }
    const el = ReactDOM.findDOMNode(this._scrollerRef);
    if (el == null) {
      return;
    }
    invariant(el instanceof HTMLElement);
    el.focus();
  }

  getTitle(): string {
    const cwdKey = this._store.getCwdKey();
    if (cwdKey == null) {
      return 'File Tree';
    }

    return nuclideUri.basename(cwdKey);
  }

  // This is unfortunate, but Atom uses getTitle() to get the text in the tab and getPath() to get
  // the text in the tool-tip.
  getPath(): string {
    const cwdKey = this._store.getCwdKey();
    if (cwdKey == null) {
      return 'No Current Working Directory';
    }

    const trimmed = nuclideUri.trimTrailingSeparator(cwdKey);
    const directory = nuclideUri.getPath(trimmed);
    const host = nuclideUri.getHostnameOpt(trimmed);
    if (host == null) {
      return `Current Working Directory: ${directory}`;
    }

    return `Current Working Directory: '${directory}' on '${host}'`;
  }

  getDefaultLocation(): atom$PaneLocation {
    return 'left';
  }

  getAllowedLocations(): Array<atom$PaneLocation> {
    return ['left', 'right'];
  }

  getPreferredWidth(): number {
    return 300;
  }

  getIconName(): string {
    return 'file-directory';
  }

  getURI(): string {
    return WORKSPACE_VIEW_URI;
  }

  didChangeVisibility(visible: boolean): void {
    this.setState({hidden: !visible});
  }

  serialize(): Object {
    return {
      deserializer: 'nuclide.FileTreeSidebarComponent',
    };
  }

  copy(): mixed {
    // The file tree store wasn't written to support multiple instances, so try to prevent it.
    return false;
  }

  isPermanentDockItem(): boolean {
    return true;
  }

  onDidChangeTitle(callback: (v: string) => mixed): IDisposable {
    return this._emitter.on('did-change-title', callback);
  }

  onDidChangePath(callback: (v: ?string) => mixed): IDisposable {
    return this._emitter.on('did-change-path', callback);
  }
}

function observeAllModifiedStatusChanges(): Observable<void> {
  const paneItemChangeEvents = Observable.merge(
    observableFromSubscribeFunction(
      atom.workspace.onDidAddPaneItem.bind(atom.workspace),
    ),
    observableFromSubscribeFunction(
      atom.workspace.onDidDestroyPaneItem.bind(atom.workspace),
    ),
  ).startWith(undefined);

  return paneItemChangeEvents.map(getCurrentBuffers).switchMap(buffers =>
    Observable.merge(
      ...(buffers.map(buffer => {
        return observableFromSubscribeFunction(
          buffer.onDidChangeModified.bind(buffer),
        );
      }): Array<Observable<void>>),
    ),
  );
}

function getCurrentBuffers(): Array<atom$TextBuffer> {
  const buffers = [];
  const editors = atom.workspace.getTextEditors();
  editors.forEach(te => {
    const buffer = te.getBuffer();

    if (typeof buffer.getPath !== 'function' || buffer.getPath() == null) {
      return;
    }

    if (buffers.indexOf(buffer) < 0) {
      buffers.push(buffer);
    }
  });

  return buffers;
}

function filterMultiRootFileChanges(
  unfilteredFileChanges: Immutable.Map<
    NuclideUri,
    Immutable.Map<NuclideUri, FileChangeStatusValue>,
  >,
): Map<NuclideUri, Map<NuclideUri, FileChangeStatusValue>> {
  const filteredFileChanges = new Map();
  // Filtering the changes to make sure they only show up under the directory the
  // file exists under.
  for (const [root, fileChanges] of unfilteredFileChanges) {
    const filteredFiles = new Map(
      fileChanges.filter((_, filePath) => filePath.startsWith(root)),
    );
    if (filteredFiles.size !== 0) {
      filteredFileChanges.set(root, filteredFiles);
    }
  }

  return filteredFileChanges;
}
