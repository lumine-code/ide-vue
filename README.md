# ide-vue

Vue language-server adapter.

Registers the bundled Vue Language Server with `ide-client`, providing diagnostics, completion, navigation, symbols, formatting, refactoring, hints, and semantic highlighting across Vue single-file components.

## Features

- **Bundled server**: pins `@vue/language-server` exactly, with optional custom server and TypeScript SDK paths.
- **Vue TypeScript bridge**: runs the matching `@vue/typescript-plugin` in a companion tsserver and answers the server's custom `tsserver/request` notifications, enabling project and component intelligence outside VS Code.
- **Whole-SFC intelligence**: serves Vue templates together with their TypeScript, JavaScript, HTML, CSS, SCSS, and Less blocks.
- **Navigation and structure**: follows components, props, bindings, styles, and script symbols and supplies references and document symbols.
- **Editing**: formats SFC blocks, renames symbols, offers fixes and refactorings, and supplies inlay hints.
- **Configuration**: controls component and prop casing, embedded formatting, automatic insertions, TypeScript imports, and Vue and TypeScript hints.
- **Feature switches**: every advertised shared IDE capability can be handed to another server serving the same Vue file.

## Installation

To install `ide-vue`, search for _ide-vue_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/ide-vue`.

## Services

- **ide-client** (`^1.0.0`): consumed to register the Vue adapter with the editor's language-server client.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
