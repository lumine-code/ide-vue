// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: [
    "language-vue",
    "marker",
    "linter",
    "diagnostics",
    "documentation-view",
    "hover",
    "ide",
  ],
  viewport: { width: 1100, height: 760 },
  async before(context) {
    const { lumine, state } = context;
    for (const p of lumine.packages.getActivePackages())
      if (
        p.name.startsWith("ide-") &&
        p.name !== "ide-vue" &&
        state.serverInstall?.[p.name]?.status !== "installing"
      )
        await lumine.packages.deactivatePackage(p.name);
  },
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("ide-vue/SignalCard.vue");
    await lumine.project.setPaths([fixture("ide-vue")]);
    lumine.grammars.assignLanguageMode(state.editor.getBuffer(), "text.html.vue");
    await state.editor.getBuffer().getLanguageMode().ready;
    await state.editor.getBuffer().getLanguageMode().atGrammarSettlement?.();
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "The Vue language server identifies an invalid CSS property inside a component.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          for (let n = 0; n < 60; n++) {
            if (
              [
                ...lumine.packages.getActivePackage("ide").mainModule.manager.sessions.values(),
              ].some((s) => s.adapter.id === "ide-vue" && s.state === "running") &&
              lumine.packages
                .getActivePackage("linter")
                .mainModule.provideMcpTools()[0]
                .execute({ filePath: state.editor.getPath() })
                .messages.filter((m) => m.linterName === "Vue Language Server").length
            )
              break;
            await new Promise((r) => setTimeout(r, 500));
          }
          if (
            ![...lumine.packages.getActivePackage("ide").mainModule.manager.sessions.values()].some(
              (s) => s.adapter.id === "ide-vue" && s.state === "running",
            )
          )
            throw new Error("The actual language server did not start");
          const messages = lumine.packages
            .getActivePackage("linter")
            .mainModule.provideMcpTools()[0]
            .execute({ filePath: state.editor.getPath() })
            .messages.filter((m) => m.linterName === "Vue Language Server");
          if (!messages.length) throw new Error("No diagnostic from the expected server");
          const message = messages.find((m) => m.severity === "error") || messages[0];
          state.evidence = {
            adapter: "ide-vue",
            provider: message.linterName,
            diagnostic: message.excerpt,
          };
          state.editor.setCursorBufferPosition(message.range.start);
          state.editor.scrollToCursorPosition();
          lumine.views.getView(state.editor).focus();
        }
      },
      async afterPointerMove(context) {
        const { lumine, state } = context;
        await lumine.packages
          .getActivePackage("hover")
          .mainModule.getManager(lumine.workspace.getMainWindow())
          .showHoverOverlay(state.editor, state.editor.getCursorBufferPosition(), { gutter: true });
      },
      ready() {
        return Boolean(
          (() => {
            const e = document.querySelector("lumine-overlay.hover-overlay");
            const r = e?.getBoundingClientRect();
            return (
              e?.innerText.includes("Vue Language Server") &&
              r.top >= 36 &&
              r.bottom <= innerHeight - 24
            );
          })(),
        );
      },
    },
  ],
  async cleanup() {},
};
