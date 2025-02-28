/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { deepClone } from 'vs/base/common/objects';
import { IEditorOptions, LineNumbersType } from 'vs/editor/common/config/editorOptions';
import { localize } from 'vs/nls';
import { Action2, MenuId, registerAction2 } from 'vs/platform/actions/common/actions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from 'vs/platform/configuration/common/configurationRegistry';
import { ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { Registry } from 'vs/platform/registry/common/platform';
import { NOTEBOOK_ACTIONS_CATEGORY } from 'vs/workbench/contrib/notebook/browser/contrib/coreActions';
import { getNotebookEditorFromEditorPane, ICellViewModel, INotebookEditor, NOTEBOOK_CELL_LINE_NUMBERS, NOTEBOOK_EDITOR_FOCUSED, NOTEBOOK_IS_ACTIVE_EDITOR } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { NotebookCellInternalMetadata } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { NotebookOptions } from 'vs/workbench/contrib/notebook/common/notebookOptions';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';

export class CellEditorOptions extends Disposable {

	private static fixedEditorOptions: IEditorOptions = {
		scrollBeyondLastLine: false,
		scrollbar: {
			verticalScrollbarSize: 14,
			horizontal: 'auto',
			useShadows: true,
			verticalHasArrows: false,
			horizontalHasArrows: false,
			alwaysConsumeMouseWheel: false
		},
		renderLineHighlightOnlyWhenFocus: true,
		overviewRulerLanes: 0,
		selectOnLineNumbers: false,
		lineNumbers: 'off',
		lineDecorationsWidth: 0,
		folding: false,
		fixedOverflowWidgets: true,
		minimap: { enabled: false },
		renderValidationDecorations: 'on',
		lineNumbersMinChars: 3
	};

	private _value: IEditorOptions;
	private _lineNumbers: 'on' | 'off' | 'inherit' = 'inherit';
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private _localDisposableStore = this._register(new DisposableStore());

	constructor(readonly notebookEditor: INotebookEditor, readonly notebookOptions: NotebookOptions, readonly configurationService: IConfigurationService, readonly language: string) {
		super();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('editor') || e.affectsConfiguration('notebook')) {
				this._recomputeOptions();
			}
		}));

		this._register(notebookOptions.onDidChangeOptions(e => {
			if (e.cellStatusBarVisibility || e.editorTopPadding || e.editorOptionsCustomizations || e.cellBreakpointMargin) {
				this._recomputeOptions();
			}
		}));

		this._register(this.notebookEditor.onDidChangeModel(() => {
			this._localDisposableStore.clear();

			if (this.notebookEditor.hasModel()) {
				this._localDisposableStore.add(this.notebookEditor.viewModel.onDidChangeOptions(() => {
					this._recomputeOptions();
				}));

				this._recomputeOptions();
			}
		}));

		if (this.notebookEditor.hasModel()) {
			this._localDisposableStore.add(this.notebookEditor.viewModel.onDidChangeOptions(() => {
				this._recomputeOptions();
			}));
		}

		this._value = this._computeEditorOptions();
	}

	private _recomputeOptions(): void {
		this._value = this._computeEditorOptions();
		this._onDidChange.fire();
	}

	private _computeEditorOptions() {
		const renderLineNumbers = this.configurationService.getValue<'on' | 'off'>('notebook.lineNumbers') === 'on';
		const lineNumbers: LineNumbersType = renderLineNumbers ? 'on' : 'off';
		const editorOptions = deepClone(this.configurationService.getValue<IEditorOptions>('editor', { overrideIdentifier: this.language }));
		const layoutConfig = this.notebookOptions.getLayoutConfiguration();
		const editorOptionsOverrideRaw = layoutConfig.editorOptionsCustomizations ?? {};
		let editorOptionsOverride: { [key: string]: any; } = {};
		for (let key in editorOptionsOverrideRaw) {
			if (key.indexOf('editor.') === 0) {
				editorOptionsOverride[key.substr(7)] = editorOptionsOverrideRaw[key];
			}
		}
		const computed = {
			...editorOptions,
			...CellEditorOptions.fixedEditorOptions,
			... { lineNumbers, folding: lineNumbers === 'on' },
			...editorOptionsOverride,
			...{ padding: { top: 12, bottom: 12 } },
			readOnly: this.notebookEditor.viewModel?.options.isReadOnly ?? false
		};

		return computed;
	}

	getValue(internalMetadata?: NotebookCellInternalMetadata): IEditorOptions {
		return {
			...this._value,
			...{
				padding: internalMetadata ?
					this.notebookOptions.computeEditorPadding(internalMetadata) :
					{ top: 12, bottom: 12 }
			}
		};
	}

	setLineNumbers(lineNumbers: 'on' | 'off' | 'inherit'): void {
		this._lineNumbers = lineNumbers;
		if (this._lineNumbers === 'inherit') {
			const renderLiNumbers = this.configurationService.getValue<'on' | 'off'>('notebook.lineNumbers') === 'on';
			const lineNumbers: LineNumbersType = renderLiNumbers ? 'on' : 'off';
			this._value.lineNumbers = lineNumbers;
			this._value.folding = lineNumbers === 'on';
		} else {
			this._value.lineNumbers = lineNumbers as LineNumbersType;
			this._value.folding = lineNumbers === 'on';
		}
		this._onDidChange.fire();
	}
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'notebook',
	order: 100,
	type: 'object',
	'properties': {
		'notebook.lineNumbers': {
			type: 'string',
			enum: ['off', 'on'],
			default: 'off',
			markdownDescription: localize('notebook.lineNumbers', "Controls the display of line numbers in the cell editor.")
		}
	}
});

registerAction2(class ToggleLineNumberAction extends Action2 {
	constructor() {
		super({
			id: 'notebook.toggleLineNumbers',
			title: { value: localize('notebook.toggleLineNumbers', "Toggle Notebook Line Numbers"), original: 'Toggle Notebook Line Numbers' },
			precondition: NOTEBOOK_EDITOR_FOCUSED,
			menu: [
				{
					id: MenuId.NotebookEditorLayoutConfigure,
					group: 'notebookLayoutDetails',
					order: 1,
					when: NOTEBOOK_IS_ACTIVE_EDITOR
				},
				{
					id: MenuId.NotebookToolbar,
					group: 'notebookLayout',
					order: 2,
					when: ContextKeyExpr.equals('config.notebook.globalToolbar', true)
				}],
			category: NOTEBOOK_ACTIONS_CATEGORY,
			f1: true,
			toggled: {
				condition: ContextKeyExpr.notEquals('config.notebook.lineNumbers', 'off'),
				title: { value: localize('notebook.showLineNumbers', "Show Notebook Line Numbers"), original: 'Show Notebook Line Numbers' },
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const renderLiNumbers = configurationService.getValue<'on' | 'off'>('notebook.lineNumbers') === 'on';

		if (renderLiNumbers) {
			configurationService.updateValue('notebook.lineNumbers', 'off');
		} else {
			configurationService.updateValue('notebook.lineNumbers', 'on');
		}
	}
});

registerAction2(class ToggleActiveLineNumberAction extends Action2 {
	constructor() {
		super({
			id: 'notebook.cell.toggleLineNumbers',
			title: 'Show Cell Line Numbers',
			precondition: NOTEBOOK_EDITOR_FOCUSED,
			menu: [{
				id: MenuId.NotebookCellTitle,
				group: 'View',
				order: 1
			}],
			toggled: ContextKeyExpr.or(
				NOTEBOOK_CELL_LINE_NUMBERS.isEqualTo('on'),
				ContextKeyExpr.and(NOTEBOOK_CELL_LINE_NUMBERS.isEqualTo('inherit'), ContextKeyExpr.equals('config.notebook.lineNumbers', 'on'))
			)
		});
	}

	async run(accessor: ServicesAccessor, context?: { cell: ICellViewModel; }): Promise<void> {
		let cell = context?.cell;
		if (!cell) {
			const editor = getNotebookEditorFromEditorPane(accessor.get(IEditorService).activeEditorPane);
			if (!editor || !editor.hasModel()) {
				return;
			}

			cell = editor.getActiveCell();
		}

		if (cell) {
			const configurationService = accessor.get(IConfigurationService);
			const renderLineNumbers = configurationService.getValue<'on' | 'off'>('notebook.lineNumbers') === 'on';
			const cellLineNumbers = cell.lineNumbers;
			// 'on', 'inherit' 	-> 'on'
			// 'on', 'off'		-> 'off'
			// 'on', 'on'		-> 'on'
			// 'off', 'inherit'	-> 'off'
			// 'off', 'off'		-> 'off'
			// 'off', 'on'		-> 'on'
			const currentLineNumberIsOn = cellLineNumbers === 'on' || (cellLineNumbers === 'inherit' && renderLineNumbers);

			if (currentLineNumberIsOn) {
				cell.lineNumbers = 'off';
			} else {
				cell.lineNumbers = 'on';
			}
		}
	}
});
