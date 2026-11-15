import java.time.Duration;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpSession;
import javax.validation.constraints.Pattern;
import javax.validation.constraints.Size;
import org.hibernate.validator.constraints.Length;
import org.mindrot.jbcrypt.BCrypt;
import org.passay.CharacterRule;
import org.passay.EnglishCharacterData;
import org.passay.LengthRule;
import org.passay.WhitespaceRule;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.RequestParam;

public class SignupForm {
    // ruleid: jgates.java.password-min-length-below-8
    @Size(min = 4, max = 100)
    private String password;

    // ruleid: jgates.java.password-min-length-below-8
    @Length(min = 6)
    private String newPassword;

    // ok: jgates.java.password-min-length-below-8
    @Size(min = 12, max = 128)
    private String confirmPassword;

    // ok: jgates.java.password-min-length-below-8
    @Size(min = 2)
    private String displayName;

    // ruleid: jgates.java.password-max-length-below-64
    @Size(max = 20)
    private String oldPassword;

    // ruleid: jgates.java.password-max-length-below-64
    @Length(min = 8, max = 32)
    private String senha;

    // ok: jgates.java.password-max-length-below-64
    @Size(max = 128)
    private String loginPassword;

    // ok: jgates.java.password-max-length-below-64
    @Size(max = 30)
    private String nickname;

    // ruleid: jgates.java.password-composition-rule
    @Pattern(regexp = "^(?=.*[A-Z])(?=.*[0-9]).+$")
    private String strongPassword;

    // ok: jgates.java.password-composition-rule
    @Pattern(regexp = "^\\S+$")
    private String plainPassword;

    // ok: jgates.java.password-composition-rule
    @Pattern(regexp = "^(?=.*[a-z]).+$")
    private String username;

    // ruleid: jgates.java.secret-question-present
    private String secretQuestion;

    // ruleid: jgates.java.secret-question-present
    @Size(max = 100)
    private String securityAnswer;

    // ok: jgates.java.secret-question-present
    private String recoveryEmail;

    // ok: jgates.java.secret-question-present
    private String question;
}

class PasswordChecks {
    boolean tooShort(String password, String newPassword, String username) {
        // ruleid: jgates.java.password-min-length-below-8
        if (password.length() < 6) {
            return true;
        }
        // ruleid: jgates.java.password-min-length-below-8
        if (newPassword.length() <= 5) {
            return true;
        }
        // ok: jgates.java.password-min-length-below-8
        if (password.length() < 12) {
            return true;
        }
        // ok: jgates.java.password-min-length-below-8
        return username.length() < 3;
    }

    boolean tooLong(String password, String name) {
        // ruleid: jgates.java.password-max-length-below-64
        if (password.length() > 20) {
            return true;
        }
        // ruleid: jgates.java.password-max-length-below-64
        if (password.length() >= 32) {
            return true;
        }
        // ok: jgates.java.password-max-length-below-64
        if (password.length() > 128) {
            return true;
        }
        // ok: jgates.java.password-max-length-below-64
        return name.length() > 20;
    }

    void passay() {
        // ruleid: jgates.java.password-min-length-below-8
        LengthRule shortRule = new LengthRule(4, 128);
        // ruleid: jgates.java.password-max-length-below-64
        LengthRule cappedRule = new LengthRule(8, 20);
        // ok: jgates.java.password-min-length-below-8
        // ok: jgates.java.password-max-length-below-64
        LengthRule goodRule = new LengthRule(12, 128);
        // ruleid: jgates.java.password-composition-rule
        CharacterRule upper = new CharacterRule(EnglishCharacterData.UpperCase, 1);
        // ruleid: jgates.java.password-composition-rule
        CharacterRule digit = new CharacterRule(EnglishCharacterData.Digit);
        // ok: jgates.java.password-composition-rule
        WhitespaceRule noSpaces = new WhitespaceRule();
    }
}

class PasswordTransform {
    boolean verify(String password, PasswordEncoder encoder, String hash) {
        String folded = password.toLowerCase();
        // ruleid: jgates.java.password-transformed-before-verify
        return encoder.matches(folded, hash);
    }

    String store(String rawPassword, PasswordEncoder encoder) {
        String cut = rawPassword.substring(0, 8);
        // ruleid: jgates.java.password-transformed-before-verify
        return BCrypt.hashpw(cut, BCrypt.gensalt());
    }

    String storeInline(String password, PasswordEncoder encoder) {
        // ruleid: jgates.java.password-transformed-before-verify
        return encoder.encode(password.toUpperCase());
    }

    boolean verifyExact(String password, PasswordEncoder encoder, String hash) {
        // ok: jgates.java.password-transformed-before-verify
        return encoder.matches(password, hash);
    }

    String storeExact(String password, PasswordEncoder encoder) {
        // ok: jgates.java.password-transformed-before-verify
        return encoder.encode(password);
    }

    boolean lookup(String username, PasswordEncoder encoder, String password, String hash) {
        String key = username.toLowerCase();
        // ok: jgates.java.password-transformed-before-verify
        return encoder.matches(password, key);
    }
}

class LoginHandler {
    void login(HttpServletRequest request, Object user) {
        // ruleid: jgates.java.session-id-not-regenerated
        request.getSession().setAttribute("user", user);
    }

    void loginWithSession(HttpSession session, Object account) {
        // ruleid: jgates.java.session-id-not-regenerated
        session.setAttribute("accountId", account);
    }

    void loginRenewed(HttpServletRequest request, Object user) {
        request.changeSessionId();
        // ok: jgates.java.session-id-not-regenerated
        request.getSession().setAttribute("user", user);
    }

    void loginNewSession(HttpServletRequest request, Object user) {
        HttpSession old = request.getSession(false);
        if (old != null) {
            old.invalidate();
        }
        // ok: jgates.java.session-id-not-regenerated
        request.getSession(true).setAttribute("user", user);
    }

    void addToCart(HttpSession session, Object cart) {
        // ok: jgates.java.session-id-not-regenerated
        session.setAttribute("cart", cart);
    }
}

class RegistrationController {
    public Object register(@RequestParam String role, @RequestParam String displayName, HttpServletRequest request) {
        Account user = new Account();
        // ruleid: jgates.java.client-controlled-privilege
        user.setRole(role);
        // ruleid: jgates.java.client-controlled-privilege
        user.setAdmin(Boolean.parseBoolean(request.getParameter("admin")));
        // ruleid: jgates.java.client-controlled-privilege
        user.getAuthorities().add(new SimpleGrantedAuthority(request.getHeader("X-Role")));
        // ok: jgates.java.client-controlled-privilege
        user.setRole("USER");
        // ok: jgates.java.client-controlled-privilege
        user.setAdmin(false);
        // ok: jgates.java.client-controlled-privilege
        user.setDisplayName(displayName);
        return user;
    }
}

class SecurityConfig {
    void configure(Http http, Web web) throws Exception {
        // ruleid: jgates.java.permit-all-requests
        http.authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        // ruleid: jgates.java.permit-all-requests
        http.authorizeHttpRequests(auth -> auth.requestMatchers("/**").permitAll());
        // ruleid: jgates.java.permit-all-requests
        web.ignoring().anyRequest();
        // ok: jgates.java.permit-all-requests
        http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
        // ok: jgates.java.permit-all-requests
        http.authorizeHttpRequests(auth -> auth.requestMatchers("/health").permitAll());
    }
}

class OtpSetup {
    void configure(Object builder, Object verifier) {
        // ruleid: jgates.java.totp-window-too-wide
        builder.setTimeStepSizeInMillis(60000L);
        // ruleid: jgates.java.totp-window-too-wide
        builder.setWindowSize(10);
        // ruleid: jgates.java.totp-window-too-wide
        verifier.setAllowedTimePeriodDiscrepancy(4);
        // ruleid: jgates.java.totp-window-too-wide
        Object slow = new TimeBasedOneTimePasswordGenerator(Duration.ofSeconds(120));
        // ok: jgates.java.totp-window-too-wide
        builder.setTimeStepSizeInMillis(30000L);
        // ok: jgates.java.totp-window-too-wide
        builder.setWindowSize(3);
        // ok: jgates.java.totp-window-too-wide
        verifier.setAllowedTimePeriodDiscrepancy(1);
        // ok: jgates.java.totp-window-too-wide
        Object normal = new TimeBasedOneTimePasswordGenerator(Duration.ofSeconds(30));
    }
}

class RecoveryHandler {
    String question(HttpServletRequest request) {
        // ruleid: jgates.java.secret-question-present
        String q = request.getParameter("secret_question");
        // ok: jgates.java.secret-question-present
        return request.getParameter("recovery_email");
    }
}
