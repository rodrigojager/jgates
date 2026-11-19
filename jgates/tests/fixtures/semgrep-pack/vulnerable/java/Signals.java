package app.signals;

import graphql.schema.GraphQLSchema;
import javax.websocket.Session;
import org.webrtc.PeerConnection;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.server.authorization.client.RegisteredClient;
import io.jsonwebtoken.Jwts;
import org.opensaml.saml.saml2.core.Assertion;
import dev.samstevens.totp.code.CodeVerifier;
import javax.naming.ldap.InitialLdapContext;
import javax.xml.parsers.DocumentBuilderFactory;
import net.spy.memcached.MemcachedClient;
import javax.mail.Transport;
import org.thymeleaf.TemplateEngine;
import org.springframework.web.multipart.MultipartFile;
import java.util.zip.ZipInputStream;
import com.google.gwt.dom.client.Document;

// A small service that touches every technology of the signal list.
public class Signals {
    public String describe() {
        return "uses everything";
    }
}
