/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	IGNORE_COMPLETION_TRIGGER,
	ISSUE_COMPLETION_FORMAT_SCM,
	ISSUES_SETTINGS_NAMESPACE,
} from '../common/settingKeys';
import { fromNewIssueUri, Schemes } from '../common/uri';
import { EXTENSION_ID } from '../constants';
import { FolderRepositoryManager, PullRequestDefaults } from '../github/folderRepositoryManager';
import { IMilestone } from '../github/interface';
import { IssueModel } from '../github/issueModel';
import { issueMarkdown } from '../github/markdownUtils';
import { RepositoriesManager } from '../github/repositoriesManager';
import { getIssueNumberLabel, variableSubstitution } from '../github/utils';
import { IssueQueryResult, StateManager } from './stateManager';
import {
	getRootUriFromScmInputUri,
	isComment,
} from './util';

class IssueCompletionItem extends vscode.CompletionItem {
	constructor(public readonly issue: IssueModel) {
		super(`${issue.number}: ${issue.title}`, vscode.CompletionItemKind.Issue);
	}
}

class ConfigureIssueQueriesCompletionItem extends vscode.CompletionItem {
	constructor() {
		super(vscode.l10n.t('Configure issue queries...'), vscode.CompletionItemKind.Text);
		this.detail = vscode.l10n.t('No issues found. Set up queries to see relevant issues.');
		this.insertText = '';
		this.command = {
			command: 'workbench.action.openSettings',
			title: vscode.l10n.t('Open Settings'),
			arguments: [`@ext:${EXTENSION_ID} githubIssues.queries`]
		};
		this.sortText = '~'; // Sort to bottom of list
	}
}

export class IssueCompletionProvider implements vscode.CompletionItemProvider {
	constructor(
		private stateManager: StateManager,
		private repositoriesManager: RepositoriesManager,
		private context: vscode.ExtensionContext,
	) { }

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.CompletionContext,
	): Promise<vscode.CompletionItem[]> {
		let wordRange = document.getWordRangeAtPosition(position);
		let wordAtPos = wordRange ? document.getText(wordRange) : undefined;
		if (!wordRange || wordAtPos?.charAt(0) !== '#') {
			const start = wordRange?.start ?? position;
			const testWordRange = new vscode.Range(start.translate(undefined, start.character ? -1 : 0), position);
			const testWord = document.getText(testWordRange);
			if (testWord.charAt(0) === '#') {
				wordRange = testWordRange;
				wordAtPos = testWord;
			}
		}

		// If the suggest was not triggered by the trigger character, require that the previous character be the trigger character
		if (
			document.languageId !== 'scminput' &&
			document.uri.scheme !== 'comment' &&
			position.character > 0 &&
			context.triggerKind === vscode.CompletionTriggerKind.Invoke &&
			!wordAtPos?.match(/#[0-9]*$/)
		) {
			return [];
		}
		// It's common in markdown to start a line with #s and not want an completion
		if (
			position.character <= 6 &&
			document.languageId === 'markdown' &&
			(document.getText(new vscode.Range(position.with(undefined, 0), position)) ===
				new Array(position.character + 1).join('#')) &&
			document.uri.scheme !== 'comment' &&
			context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter
		) {
			return [];
		}

		if (
			context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter &&
			vscode.workspace
				.getConfiguration(ISSUES_SETTINGS_NAMESPACE)
				.get<string[]>(IGNORE_COMPLETION_TRIGGER, [])
				.find(value => value === document.languageId)
		) {
			return [];
		}

		if ((document.languageId !== 'scminput') && (document.languageId !== 'git-commit') && !(await isComment(document, position))) {
			return [];
		}

		let range: vscode.Range = new vscode.Range(position, position);
		if (position.character - 1 >= 0) {
			if (wordRange && ((wordAtPos?.charAt(0) === '#') || (document.languageId === 'scminput') || (document.languageId === 'git-commit'))) {
				range = wordRange;
			}
		}

		// Check for owner/repo preceding the #
		let filterOwnerAndRepo: { owner: string; repo: string } | undefined;
		if (wordAtPos === '#' && wordRange) {
			if (wordRange.start.character >= 3) {
				const ownerRepoRange = new vscode.Range(
					wordRange.start.with(undefined, 0),
					wordRange.start
				);
				const ownerRepo = document.getText(ownerRepoRange);
				const ownerRepoMatch = ownerRepo.match(/([^\s]+)\/([^\s]+)/);
				if (ownerRepoMatch) {
					filterOwnerAndRepo = {
						owner: ownerRepoMatch[1],
						repo: ownerRepoMatch[2],
					};
				}
			}
		}

		const completionItems: Map<string, IssueCompletionItem> = new Map();
		let repo: PullRequestDefaults | undefined;
		let uri: vscode.Uri | undefined;
		if (document.languageId === 'scminput') {
			uri = getRootUriFromScmInputUri(document.uri);
		} else if ((document.uri.scheme === 'comment') && vscode.workspace.workspaceFolders?.length) {
			for (const visibleEditor of vscode.window.visibleTextEditors) {
				const testFolderUri = vscode.workspace.workspaceFolders[0].uri.with({ path: visibleEditor.document.uri.path });
				const workspace = vscode.workspace.getWorkspaceFolder(testFolderUri);
				if (workspace) {
					uri = workspace.uri;
					break;
				}
			}
		} else {
			uri = document.uri.scheme === Schemes.NewIssue
				? fromNewIssueUri(document.uri)?.originUri ?? document.uri
				: document.uri;
		}
		if (!uri) {
			return [];
		}

		let folderManager: FolderRepositoryManager | undefined;
		try {
			folderManager = this.repositoriesManager.getManagerForFile(uri);
			repo = await folderManager?.getPullRequestDefaults();
		} catch (e) {
			// leave repo undefined
		}
		const issueData = this.stateManager.getIssueCollection(folderManager?.repository.rootUri ?? uri);

		for (const issueQuery of issueData) {
			const issuesOrMilestones: IssueQueryResult = await issueQuery[1];
			if ((issuesOrMilestones.issues ?? []).length === 0) {
				continue;
			}
			for (const issue of (issuesOrMilestones.issues ?? [])) {
				if (filterOwnerAndRepo && ((issue as IssueModel).remote.owner !== filterOwnerAndRepo.owner || (issue as IssueModel).remote.repositoryName !== filterOwnerAndRepo.repo)) {
					continue;
				}
				completionItems.set(
					getIssueNumberLabel(issue as IssueModel),
					await this.completionItemFromIssue(repo, issue as IssueModel, range, document),
				);
			}

		}
		
		// If no issues were found, show a configuration prompt
		if (completionItems.size === 0) {
			return [new ConfigureIssueQueriesCompletionItem()];
		}
		
		return [...completionItems.values()];
	}

	private async completionItemFromIssue(
		repo: PullRequestDefaults | undefined,
		issue: IssueModel,
		range: vscode.Range,
		document: vscode.TextDocument,
		milestone?: IMilestone,
	): Promise<IssueCompletionItem> {
		const item: IssueCompletionItem = new IssueCompletionItem(issue);
		if (document.languageId === 'markdown') {
			item.insertText = `[${getIssueNumberLabel(issue, repo)}](${issue.html_url})`;
		} else {
			const configuration = vscode.workspace
				.getConfiguration(ISSUES_SETTINGS_NAMESPACE)
				.get(ISSUE_COMPLETION_FORMAT_SCM);
			if (document.uri.path.match(/git\/scm\d\/input/) && typeof configuration === 'string') {
				item.insertText = await variableSubstitution(configuration, issue, repo);
			} else {
				item.insertText = `${getIssueNumberLabel(issue, repo)}`;
			}
		}
		item.documentation = issue.body;
		item.range = range;
		item.detail = milestone ? milestone.title : issue.milestone?.title;
		const sortTime = Number.MAX_SAFE_INTEGER - new Date(issue.updatedAt).getTime();
		item.sortText = sortTime.toString().padStart(15, '0');
		item.filterText = `${item.detail} # ${issue.number} ${issue.title} ${item.documentation}`;
		return item;
	}

	async resolveCompletionItem(
		item: vscode.CompletionItem,
		_token: vscode.CancellationToken,
	): Promise<vscode.CompletionItem> {
		if (item instanceof IssueCompletionItem) {
			item.documentation = await issueMarkdown(item.issue, this.context, this.repositoriesManager);
			item.command = {
				command: 'issues.issueCompletion',
				title: vscode.l10n.t('Issue Completion Choose,'),
			};
		}
		return item;
	}
}
