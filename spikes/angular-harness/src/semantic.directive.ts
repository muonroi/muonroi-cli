import { Directive, forwardRef, Input, inject, type OnDestroy, type OnInit } from "@angular/core";
import { SEMANTIC_PARENT_ID } from "./parent-id.token";
import { SemanticRegistry } from "./registry.service";

/**
 * [muonroiSemantic] — structural annotation directive.
 *
 * Marks a host element as a semantic node in the agent-harness tree.
 * Key design:
 *
 * 1. Parent resolution via element-injector chain:
 *    inject(SEMANTIC_PARENT_ID, { optional: true, skipSelf: true })
 *    skips this element's own injector and walks UP the element-injector
 *    hierarchy. Result: nearest enclosing [muonroiSemantic] on a parent DOM
 *    node is found — NOT the component-root injector.
 *    This validates the HIGH-4 risk: for
 *      <div muonroiSemantic id="d"><span muonroiSemantic id="s">...</span></div>
 *    the span's parentId resolves to "d", not to the component host.
 *
 * 2. Re-provision via providers array:
 *    { provide: SEMANTIC_PARENT_ID, useFactory: (d) => d.id, deps: [forwardRef(() => SemanticDirective)] }
 *    forwardRef is required because the class body references itself in its own
 *    decorator metadata. Angular resolves the forward ref at runtime, after the
 *    class is fully defined. The factory returns the directive's own id, making
 *    it visible to child element injectors.
 */
@Directive({
  selector: "[muonroiSemantic]",
  standalone: true,
  providers: [
    {
      provide: SEMANTIC_PARENT_ID,
      // forwardRef resolves circular class reference in providers metadata.
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      useFactory: (self: { id: string }) => self.id,
      // biome-ignore lint/correctness/noInvalidUseBeforeDeclaration: forwardRef pattern required for Angular self-provision
      deps: [forwardRef(() => SemanticDirective)],
    },
  ],
})
export class SemanticDirective implements OnInit, OnDestroy {
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
   * Resolved parent id.
   * skipSelf: walks past this element's own element-injector (where we
   *   just provided our own id) — so we don't resolve to ourselves.
   * optional: returns null at component/module root where no ancestor exists.
   *
   * Critical proof: in <div [muonroiSemantic] id="d">
   *                         <span [muonroiSemantic] id="s">x</span>
   *                       </div>
   * the span's element injector has `SEMANTIC_PARENT_ID = "s"` (own).
   * skipSelf skips that and finds div's element injector → "d". ✓
   */
  readonly parentId: string | null = inject(SEMANTIC_PARENT_ID, {
    optional: true,
    skipSelf: true,
  });

  private readonly registry = inject(SemanticRegistry);
  private unregister?: () => void;

  ngOnInit(): void {
    this.unregister = this.registry.register({
      id: this.id,
      role: this.role,
      name: this.name,
      value: this.value,
      state: this.state,
      isModal: this.isModal,
      focus: this.focus,
      selected: this.selected,
      disabled: this.disabled,
      props: this.props,
      parentId: this.parentId,
    });
  }

  ngOnDestroy(): void {
    this.unregister?.();
  }
}
