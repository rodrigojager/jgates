import java.time.Duration;
import javax.servlet.http.HttpServletRequest;
import javax.validation.constraints.Pattern;
import javax.validation.constraints.Size;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.RequestParam;

public class PasswordsSessions {
    @Size(min = 12, max = 128)
    private String password;

    @Size(max = 128)
    private String oldPassword;

    @Pattern(regexp = "^\\S+$")
    private String newPassword;

    private String recoveryEmail;

    boolean verify(String loginPassword, PasswordEncoder encoder, String hash) {
        return encoder.matches(loginPassword, hash);
    }

    void login(HttpServletRequest request, Object user) {
        request.changeSessionId();
        request.getSession().setAttribute("user", user);
    }

    Object register(@RequestParam String displayName) {
        Account account = new Account();
        account.setRole("USER");
        account.setDisplayName(displayName);
        return account;
    }

    void configure(Http http) throws Exception {
        http.authorizeHttpRequests(auth -> auth.anyRequest().authenticated());
    }

    void otp(Object builder) {
        builder.setWindowSize(3);
    }
}
