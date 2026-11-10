{
  description = "Spatial Desktop for DimOS Desktop";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = forAll (pkgs:
        let
          # The page is served as it is (no build step) and the server has no dependencies beyond Deno itself.
          source = pkgs.lib.fileset.toSource { root = ./.; fileset = pkgs.lib.fileset.unions [ ./frontend ./server ]; };
        in rec {
          dimosApp = pkgs.writeShellScriptBin "dimos-app-server" ''
            exec ${pkgs.deno}/bin/deno run -A --no-lock --no-remote ${source}/server/main.ts --frontend ${source}/frontend "$@"
          '';
          default = dimosApp;
        });
    };
}
