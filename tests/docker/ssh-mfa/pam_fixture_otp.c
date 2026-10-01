/*
 * Test-only PAM module for the ssh-mfa fixture (#3384). NEVER use outside tests.
 *
 * Asks one masked "Verification code: " question and accepts the fixed one-time
 * code below. Any other answer is stored as PAM_AUTHTOK and reported as
 * PAM_AUTH_ERR, so the next module (`pam_unix.so use_first_pass`) can check it as
 * the account password. That is what lets ONE `sshd` PAM stack serve both
 * methods of `AuthenticationMethods password,keyboard-interactive`:
 *
 *   - password: sshd's password conversation answers the prompt with the typed
 *     password, which is not the code, so pam_unix verifies it.
 *   - keyboard-interactive: the user answers the prompt; the code succeeds, a
 *     wrong code is then rejected by pam_unix (it is not the password either).
 */
#define PAM_SM_AUTH
#include <security/pam_appl.h>
#include <security/pam_ext.h>
#include <security/pam_modules.h>
#include <stdlib.h>
#include <string.h>

#define FIXTURE_OTP "424242"

PAM_EXTERN int pam_sm_authenticate(pam_handle_t *pamh, int flags, int argc,
                                   const char **argv) {
    (void)flags;
    (void)argc;
    (void)argv;
    char *resp = NULL;
    if (pam_prompt(pamh, PAM_PROMPT_ECHO_OFF, &resp, "Verification code: ") !=
            PAM_SUCCESS ||
        resp == NULL) {
        return PAM_AUTH_ERR;
    }
    int ok = strcmp(resp, FIXTURE_OTP) == 0;
    if (!ok) {
        pam_set_item(pamh, PAM_AUTHTOK, resp);
    }
    memset(resp, 0, strlen(resp));
    free(resp);
    return ok ? PAM_SUCCESS : PAM_AUTH_ERR;
}

PAM_EXTERN int pam_sm_setcred(pam_handle_t *pamh, int flags, int argc,
                              const char **argv) {
    (void)pamh;
    (void)flags;
    (void)argc;
    (void)argv;
    return PAM_SUCCESS;
}
