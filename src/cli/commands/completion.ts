// `automaton completion <shell>` — print a shell-completion script.
//
// Static scripts per shell so there's zero runtime dependency on a
// dynamic completion framework (commander doesn't ship one). Operators
// install with `eval "$(automaton completion bash)"` or by dumping the
// script into their shell's fpath / completions directory.
//
// Coverage: top-level subcommands + the non-flag operand sets that
// repeat often (stake subcommands, shell names, --format values,
// --network values, --log-level values). Positional args (stake
// amounts, mnemonic / password file paths) fall through to the
// shell's default filename completion, which is what operators want.

import { Command } from 'commander';

// NB: `\${...}` in TS template literals escapes to a literal `${...}`
// in the emitted string — the bash variable expansion stays intact.

const BASH_SCRIPT = `#!/usr/bin/env bash
# bash completion for automaton.
# Install (current shell only):
#   eval "$(automaton completion bash)"
# Install (system-wide, requires bash-completion):
#   automaton completion bash | sudo tee /etc/bash_completion.d/automaton

_automaton_completions() {
    local cur prev subcommands stake_subs config_subs shells
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"

    subcommands="init doctor status stake run completion config"
    stake_subs="register increase request-unstake cancel-unstake withdraw"
    config_subs="show"
    shells="bash zsh fish"

    # Flag-value completion (applies at any depth).
    case "\$prev" in
        --format) COMPREPLY=( \$(compgen -W "human json" -- "\$cur") ); return ;;
        --network) COMPREPLY=( \$(compgen -W "testnet mainnet" -- "\$cur") ); return ;;
        --log-level) COMPREPLY=( \$(compgen -W "trace debug info warn error" -- "\$cur") ); return ;;
    esac

    # Subcommand completion.
    case "\${COMP_WORDS[1]:-}" in
        stake)
            if [[ \$COMP_CWORD -eq 2 ]]; then
                COMPREPLY=( \$(compgen -W "\$stake_subs" -- "\$cur") )
                return
            fi
            ;;
        completion)
            if [[ \$COMP_CWORD -eq 2 ]]; then
                COMPREPLY=( \$(compgen -W "\$shells" -- "\$cur") )
                return
            fi
            ;;
        config)
            if [[ \$COMP_CWORD -eq 2 ]]; then
                COMPREPLY=( \$(compgen -W "\$config_subs" -- "\$cur") )
                return
            fi
            ;;
        "")
            COMPREPLY=( \$(compgen -W "\$subcommands --help --version" -- "\$cur") )
            return
            ;;
    esac
}
complete -F _automaton_completions automaton
`;

const ZSH_SCRIPT = `#compdef automaton
# zsh completion for automaton.
# Install (run once):
#   automaton completion zsh > "\${fpath[1]}/_automaton"
#   autoload -U compinit && compinit

_automaton() {
    local -a subcommands stake_subs shells config_subs
    subcommands=(
        'init:first-run scaffold (wallet + config)'
        'doctor:environment + install + runtime sanity'
        'status:operator snapshot'
        'stake:pool lifecycle subcommands'
        'run:start the daemon'
        'completion:print shell completion script'
        'config:show the effective config'
    )
    stake_subs=(
        'register:first-time registration with collateral'
        'increase:top up staked collateral'
        'request-unstake:start the cooldown'
        'cancel-unstake:abort a pending unstake'
        'withdraw:finalize after cooldown'
    )
    shells=('bash' 'zsh' 'fish')
    config_subs=('show:print the effective config')

    _arguments -C \\
        '1: :->command' \\
        '*:: :->subargs'

    case \$state in
        command)
            _describe -t commands 'automaton' subcommands
            ;;
        subargs)
            case \${words[1]} in
                stake) _describe -t 'stake' 'stake subcommand' stake_subs ;;
                completion) _describe -t 'shell' 'shells' shells ;;
                config) _describe -t 'config' 'config subcommand' config_subs ;;
            esac
            ;;
    esac
}
_automaton "\$@"
`;

const FISH_SCRIPT = `# fish completion for automaton.
# Install:
#   automaton completion fish > ~/.config/fish/completions/automaton.fish

complete -c automaton -f

# Top-level
complete -c automaton -n "__fish_use_subcommand" -a "init" -d "first-run scaffold (wallet + config)"
complete -c automaton -n "__fish_use_subcommand" -a "doctor" -d "environment + install + runtime sanity"
complete -c automaton -n "__fish_use_subcommand" -a "status" -d "operator snapshot"
complete -c automaton -n "__fish_use_subcommand" -a "stake" -d "pool lifecycle subcommands"
complete -c automaton -n "__fish_use_subcommand" -a "run" -d "start the daemon"
complete -c automaton -n "__fish_use_subcommand" -a "completion" -d "print shell completion script"
complete -c automaton -n "__fish_use_subcommand" -a "config" -d "show the effective config"

# Nested
complete -c automaton -n "__fish_seen_subcommand_from stake" -a "register increase request-unstake cancel-unstake withdraw"
complete -c automaton -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"
complete -c automaton -n "__fish_seen_subcommand_from config" -a "show"

# Flag values
complete -c automaton -l format -a "human json"
complete -c automaton -l network -a "testnet mainnet"
complete -c automaton -l log-level -a "trace debug info warn error"
`;

export function registerCompletionCommand(program: Command): void {
    program
        .command('completion <shell>')
        .description(
            'Print a shell-completion script for bash / zsh / fish. ' +
                'Install with `eval "$(automaton completion bash)"` (bash) or dump to your fpath (zsh / fish).',
        )
        .action((shell: string) => {
            switch (shell) {
                case 'bash':
                    process.stdout.write(BASH_SCRIPT);
                    return;
                case 'zsh':
                    process.stdout.write(ZSH_SCRIPT);
                    return;
                case 'fish':
                    process.stdout.write(FISH_SCRIPT);
                    return;
                default:
                    process.stderr.write(
                        `error: unsupported shell "${shell}". Supported: bash, zsh, fish.\n`,
                    );
                    process.exit(2);
            }
        });
}
