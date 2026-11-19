import java.time.Duration;
import javax.servlet.http.HttpServletRequest;
import javax.validation.constraints.Pattern;
import javax.validation.constraints.Size;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.RequestParam;

public class PasswordsSessions {
    @Size(min = 4, max = 100)
    private String password;

    @Size(max = 20)
    private String oldPassword;

    @Pattern(regexp = "^(?=.*[A-Z])(?=.*[0-9]).+$")
    private String newPassword;

    private String secretQuestion;

    boolean verify(String loginPassword, PasswordEncoder encoder, String hash) {
        String folded = loginPassword.toLowerCase();
        return encoder.matches(folded, hash);
    }

    void login(HttpServletRequest request, Object user) {
        request.getSession().setAttribute("user", user);
    }

    Object register(@RequestParam String role) {
        Account account = new Account();
        account.setRole(role);
        return account;
    }

    void configure(Http http) throws Exception {
        http.authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
    }

    void otp(Object builder) {
        builder.setWindowSize(10);
    }
}
