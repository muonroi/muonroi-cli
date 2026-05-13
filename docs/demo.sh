#!/usr/bin/env bash
# Demo script for muonroi-cli council feature
# Run via VHS: vhs docs/demo.tape

BOLD='\033[1m'
DIM='\033[2m'
BLUE='\033[38;5;75m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
MAGENTA='\033[35m'
GRAY='\033[38;5;245m'
WHITE='\033[97m'
RESET='\033[0m'

clear

sleep 0.3

printf "${CYAN}❯${RESET} "
sleep 0.3

CMD="/council Should we use REST or gRPC for internal microservices?"
for (( i=0; i<${#CMD}; i++ )); do
  printf "${WHITE}${CMD:$i:1}${RESET}"
  sleep 0.025
done
sleep 0.4
echo ""
sleep 0.5

printf "\n"
printf "${BOLD}${BLUE}⚡ Council${RESET}  ${GRAY}3 models · adversarial debate · convergence detection${RESET}\n"
printf "${GRAY}   Topic: Should we use REST or gRPC for internal microservices?${RESET}\n\n"
sleep 0.8

printf "${BOLD}Phase 1 — Opening${RESET}  ${GRAY}parallel${RESET}\n"
sleep 0.3
printf "  ${YELLOW}◌${RESET}  ${BOLD}leader${RESET}      claude-sonnet-4-6   ${GRAY}analyzing...${RESET}\n"
printf "  ${YELLOW}◌${RESET}  ${BOLD}implement${RESET}   deepseek-v4-flash   ${GRAY}analyzing...${RESET}\n"
printf "  ${YELLOW}◌${RESET}  ${BOLD}verify${RESET}      claude-sonnet-4-6   ${GRAY}analyzing...${RESET}\n"
sleep 2.2

printf "\033[3A\033[0J"
printf "  ${GREEN}✓${RESET}  ${BOLD}leader${RESET}      claude-sonnet-4-6   ${GRAY}done  (2.1s)${RESET}\n"
printf "  ${GREEN}✓${RESET}  ${BOLD}implement${RESET}   deepseek-v4-flash   ${GRAY}done  (1.8s)${RESET}\n"
printf "  ${YELLOW}◌${RESET}  ${BOLD}verify${RESET}      claude-sonnet-4-6   ${GRAY}thinking...${RESET}\n"
sleep 1.4

printf "\033[1A\033[0J"
printf "  ${GREEN}✓${RESET}  ${BOLD}verify${RESET}      claude-sonnet-4-6   ${GRAY}done  (3.3s)${RESET}\n"
sleep 0.5

printf "\n${BOLD}Phase 2 — Discussion${RESET}  ${GRAY}convergence check after each round${RESET}\n\n"
sleep 0.6

printf "  ${GRAY}Round 1${RESET}\n"
sleep 0.4
printf "  ${YELLOW}implement:${RESET}  gRPC gives us type safety and 3–5x throughput.\n"
printf "              REST adds unnecessary serialization overhead internally.\n"
sleep 1.4
printf "\n  ${MAGENTA}verify:${RESET}     Agree on throughput. But gRPC adds operational friction —\n"
printf "              proto management, service mesh, harder to debug.\n"
printf "              Are we optimizing prematurely?\n"
sleep 1.5
printf "\n  ${YELLOW}implement:${RESET}  Valid. Team size matters here. REST wins if <10 engineers.\n"
printf "              gRPC pays off when cross-service calls dominate latency.\n"
sleep 1.3

printf "\n  ${GRAY}convergence:${RESET} ${YELLOW}partial agreement${RESET} — continuing\n\n"
sleep 0.7

printf "  ${GRAY}Round 2${RESET}\n"
sleep 0.4
printf "  ${MAGENTA}verify:${RESET}     Updating my position. Hybrid is right: gRPC for hot paths,\n"
printf "              REST for management/admin APIs.\n"
sleep 1.2
printf "\n  ${YELLOW}implement:${RESET}  Agreed. This is the established industry pattern.\n"
sleep 1.0
printf "\n  ${GRAY}convergence:${RESET} ${GREEN}✓ consensus reached${RESET} — stopping early\n\n"
sleep 0.8

printf "${BOLD}Phase 3 — Synthesis${RESET}\n"
sleep 1.6

printf "\n${BOLD}${BLUE}Recommendation${RESET}\n"
printf "${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}Hybrid architecture${RESET} — gRPC for high-throughput paths, REST for management.\n\n"
printf "  ${GREEN}●${RESET}  ${BOLD}gRPC${RESET}   auth validation, data pipelines, event streaming\n"
printf "  ${GREEN}●${RESET}  ${BOLD}REST${RESET}   admin endpoints, config APIs, third-party integrations\n\n"
printf "  Both models converged after Round 2. The debate surfaced the\n"
printf "  team-size constraint that changes the answer — often missed in\n"
printf "  single-model responses.\n\n"
printf "${GRAY}  3 models · 2 rounds · 47s · \$0.003${RESET}\n"
printf "${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
sleep 2
