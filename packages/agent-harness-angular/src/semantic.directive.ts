import {
  Directive,
  forwardRef,
  Input,
  inject,
  type OnChanges,
  type OnDestroy,
  type OnInit,
  type SimpleChanges,
} from "@angular/core";
import type { SemanticNodeInput } from "@muonroi/agent-harness-core";
import { SEMANTIC_PARENT_ID } from "./parent-id.token.js";
import { SemanticRegistryService } from "./registry.service.js";

/**
 * [muonroiSemantic] — structural annotation directive.
 *
 * Marks a host element as a semantic node in the agent-harness tree.
 *
 * ## Parent resolution via element-injector chain (HIGH-4 mitigated)
 *
 * inject(SEMANTIC_PARENT_ID, { optional: true, skipSelf: true })
 * skips this element's own injector and walks UP the element-injector hierarchy.
 * Result: nearest enclosing [muonroiSemantic] on a parent DOM node is found,
 * NOT the component-root injector.
 *
 * Proof: for
 *   <div [muonroiSemantic] id="d" role="region">
 *     <span [muonroiSemantic] id="s" role="button">x</span>
 *   </div>
 * the span's inject resolves to "d", not to the component host.
 *
 * ## Re-provision for children
 *
 * providers: [{ provide: SEMANTIC_PARENT_ID, useFactory: () => this.id }]
 * forwardRef is required because the class references itself in its own decorator.
 * Angular resolves the forward ref at runtime, after the class is fully defined.
 */
@Directive({
  selector: "[muonroiSemantic]",
  standalone: true,
  providers: [
    {
      provide: SEMANTIC_PARENT_ID,
      // forwardRef resolves circular class reference in providers metadata.
      // Spike finding: this pattern is required for self-provision in Angular.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      useFactory: (self: SemanticDirective) => self.id,
      // biome-ignore lint/correctness/noInvalidUseBeforeDeclaration: forwardRef pattern required for Angular self-provision
      deps: [forwardRef(() => SemanticDirective)],
    },
  ],
})
export class SemanticDirective implements OnInit, OnChanges, OnDestroy {
  @Input({ required: true }) id!: string;
  @Input({ required: true }) role!: string;
  @Input() name?: string;
  @Input() value?: string;
  @Input() state?: string;
  @Input() isModal?: boolean;
  @Input() focus?: boolean;
  @Input() selected?: boolean;
  @Input() disabled?: boolean;
  @Input() props?: Record<string, unknown>;

  /**
   * Resolved parent id from the element-injector chain.
   * skipSelf: walks past this element's own injector (where we just
   *   provided our own id) so we don't resolve to ourselves.
   * optional: returns null at component/module root where no ancestor exists.
   */
  readonly parentId: string | null = inject(SEMANTIC_PARENT_ID, {
    optional: true,
    skipSelf: true,
  });

  private readonly registry = inject(SemanticRegistryService);
  private unregister?: () => void;

  ngOnInit(): void {
    this.unregister = this.registry.register(this._toNodeInput());
  }

  ngOnChanges(_changes: SimpleChanges): void {
    if (!this.unregister) return; // not yet initialized
    // Patch in-place with the current non-id/parentId fields.
    // Boolean flags are coerced: only `true` is passed; `false`/undefined → undefined.
    this.registry.update(this.id, {
      name: this.name,
      value: this.value,
      state: this.state,
      isModal: this.isModal || undefined,
      focus: this.focus || undefined,
      selected: this.selected || undefined,
      disabled: this.disabled || undefined,
      props: this.props,
    });
  }

  ngOnDestroy(): void {
    this.unregister?.();
  }

  private _toNodeInput(): SemanticNodeInput {
    // Boolean flags: only `true` is passed; `false`/undefined → undefined.
    return {
      id: this.id,
      role: this.role as SemanticNodeInput["role"],
      parentId: this.parentId ?? undefined,
      name: this.name,
      value: this.value,
      state: this.state,
      isModal: this.isModal || undefined,
      focus: this.focus || undefined,
      selected: this.selected || undefined,
      disabled: this.disabled || undefined,
      props: this.props,
    };
  }
}
