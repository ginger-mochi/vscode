/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, Event, EventEmitter, SourceControlActionButton, SourceControlHistoryItem, SourceControlHistoryItemChange, SourceControlHistoryItemGroup, SourceControlHistoryOptions, SourceControlHistoryProvider, ThemeIcon } from 'vscode';
import { Repository } from './repository';
import { IDisposable } from './util';
import { toGitUri } from './uri';
import { SyncActionButton } from './actionButton';

export class GitHistoryProvider implements SourceControlHistoryProvider, IDisposable {

	private readonly _onDidChangeActionButton = new EventEmitter<void>();
	readonly onDidChangeActionButton: Event<void> = this._onDidChangeActionButton.event;

	private readonly _onDidChangeCurrentHistoryItemGroup = new EventEmitter<void>();
	readonly onDidChangeCurrentHistoryItemGroup: Event<void> = this._onDidChangeCurrentHistoryItemGroup.event;

	private _actionButton: SourceControlActionButton | undefined;
	get actionButton(): SourceControlActionButton | undefined { return this._actionButton; }
	set actionButton(button: SourceControlActionButton | undefined) {
		this._actionButton = button;
		this._onDidChangeActionButton.fire();
	}

	private _currentHistoryItemGroup: SourceControlHistoryItemGroup | undefined;

	get currentHistoryItemGroup(): SourceControlHistoryItemGroup | undefined { return this._currentHistoryItemGroup; }
	set currentHistoryItemGroup(value: SourceControlHistoryItemGroup | undefined) {
		this._currentHistoryItemGroup = value;
		this._onDidChangeCurrentHistoryItemGroup.fire();
	}

	private disposables: Disposable[] = [];

	constructor(protected readonly repository: Repository) {
		const actionButton = new SyncActionButton(repository);
		this.actionButton = actionButton.button;
		this.disposables.push(actionButton);

		this.disposables.push(repository.onDidRunGitStatus(this.onDidRunGitStatus, this));
		this.disposables.push(actionButton.onDidChange(() => this.actionButton = actionButton.button));
	}

	private async onDidRunGitStatus(): Promise<void> {
		if (!this.repository.HEAD?.name || !this.repository.HEAD?.commit) { return; }

		this.currentHistoryItemGroup = {
			id: `refs/heads/${this.repository.HEAD.name}`,
			label: this.repository.HEAD.name,
			upstream: this.repository.HEAD.upstream ?
				{
					id: `refs/remotes/${this.repository.HEAD.upstream.remote}/${this.repository.HEAD.upstream.name}`,
					label: `${this.repository.HEAD.upstream.remote}/${this.repository.HEAD.upstream.name}`,
				} : undefined
		};
	}

	async provideHistoryItems(historyItemGroupId: string, options: SourceControlHistoryOptions): Promise<SourceControlHistoryItem[]> {
		//TODO@lszomoru - support limit and cursor
		if (typeof options.limit === 'number') {
			throw new Error('Unsupported options.');
		}
		if (typeof options.limit?.id !== 'string') {
			throw new Error('Unsupported options.');
		}

		const optionsRef = options.limit.id;
		const [commits, summary] = await Promise.all([
			this.repository.log({ range: `${optionsRef}..${historyItemGroupId}`, sortByAuthorDate: true }),
			this.getSummaryHistoryItem(optionsRef, historyItemGroupId)
		]);

		const historyItems = commits.length === 0 ? [] : [summary];
		historyItems.push(...commits.map(commit => {
			const newLineIndex = commit.message.indexOf('\n');
			const subject = newLineIndex !== -1 ? commit.message.substring(0, newLineIndex) : commit.message;

			return {
				id: commit.hash,
				parentIds: commit.parents,
				label: subject,
				description: commit.authorName,
				icon: new ThemeIcon('account'),
				timestamp: commit.authorDate?.getTime()
			};
		}));

		return historyItems;
	}

	async provideHistoryItemChanges(historyItemId: string): Promise<SourceControlHistoryItemChange[]> {
		const [ref1, ref2] = historyItemId.includes('..')
			? historyItemId.split('..')
			: [`${historyItemId}^`, historyItemId];

		const changes = await this.repository.diffBetween(ref1, ref2);

		return changes.map(change => ({
			uri: change.uri.with({ query: `ref=${historyItemId}` }),
			originalUri: toGitUri(change.originalUri, ref1),
			modifiedUri: toGitUri(change.originalUri, ref2),
			renameUri: change.renameUri,
		}));
	}

	async resolveHistoryItemGroupCommonAncestor(refId1: string, refId2: string | undefined): Promise<{ id: string; ahead: number; behind: number } | undefined> {
		refId2 = refId2 ?? (await this.repository.getDefaultBranch()).name ?? '';
		if (refId2 === '') {
			return undefined;
		}

		const ancestor = await this.repository.getMergeBase(refId1, refId2);
		if (ancestor === '') {
			return undefined;
		}

		const commitCount = await this.repository.getCommitCount(`${refId1}...${refId2}`);
		return { id: ancestor, ahead: commitCount.ahead, behind: commitCount.behind };
	}

	private async getSummaryHistoryItem(ref1: string, ref2: string): Promise<SourceControlHistoryItem> {
		const diffShortStat = await this.repository.diffBetweenShortStat(ref1, ref2);
		return { id: `${ref1}..${ref2}`, parentIds: [], icon: new ThemeIcon('files'), label: 'Changes', description: diffShortStat };
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}
