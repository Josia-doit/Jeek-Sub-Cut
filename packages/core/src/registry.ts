import type {
  CommandStack,
  Contribution,
  ContributionKind,
  EventBus,
  Id,
  JeekModule,
  ModuleContext,
  ModuleRegistry,
  ProjectDocument,
} from "@jeek/contracts";

export interface RegistryDeps {
  document(): ProjectDocument;
  commands: CommandStack;
  events: EventBus;
}

/** 模块只向注册表「贡献能力」；删模块 = 贡献点一起消失，不会留悬空引用 */
export function createModuleRegistry(deps: RegistryDeps): ModuleRegistry {
  const modules = new Map<Id, JeekModule>();
  const contributions = new Map<Id, Contribution>();

  const contextFor = (moduleId: Id): ModuleContext => ({
    commands: deps.commands,
    events: deps.events,
    document: deps.document,
    register(contribution) {
      contributions.set(contribution.id, { ...contribution, moduleId });
    },
    unregister(contributionId) {
      contributions.delete(contributionId);
    },
  });

  return {
    async use(module: JeekModule): Promise<void> {
      if (modules.has(module.id)) throw new Error(`模块已注册：${module.id}`);
      const ctx = contextFor(module.id);
      await module.activate(ctx);
      modules.set(module.id, module);
      deps.events.emit("module:activated", { id: module.id });
    },
    async drop(moduleId: Id): Promise<void> {
      const module = modules.get(moduleId);
      if (!module) return;
      const ctx = contextFor(moduleId);
      await module.deactivate?.(ctx);
      modules.delete(moduleId);
      for (const [id, contribution] of contributions) {
        if (contribution.moduleId === moduleId) contributions.delete(id);
      }
      deps.events.emit("module:deactivated", { id: moduleId });
    },
    list(): readonly JeekModule[] {
      return [...modules.values()];
    },
    contributions(kind?: ContributionKind): readonly Contribution[] {
      const all = [...contributions.values()];
      return kind ? all.filter((c) => c.kind === kind) : all;
    },
    has(moduleId: Id): boolean {
      return modules.has(moduleId);
    },
  };
}
