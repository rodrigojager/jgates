import com.fasterxml.jackson.annotation.JsonAutoDetect;
import com.fasterxml.jackson.annotation.JsonAutoDetect.Visibility;
import com.fasterxml.jackson.annotation.PropertyAccessor;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.apache.commons.beanutils.BeanUtils;
import org.springframework.web.bind.WebDataBinder;

public class ConfigurationSamples {
    void debugMode(boolean isDevProfile) {
        // ruleid: jgates.java.debug-mode-enabled
        System.setProperty("debug", "true");
        // ruleid: jgates.java.debug-mode-enabled
        System.setProperty("struts.devMode", "true");
        // ruleid: jgates.java.debug-mode-enabled
        wicket.setConfigurationType(RuntimeConfigurationType.DEVELOPMENT);
        // ruleid: jgates.java.debug-mode-enabled
        vaadin.setProductionMode(false);
        // ok: jgates.java.debug-mode-enabled
        System.setProperty("debug", "false");
        // ok: jgates.java.debug-mode-enabled
        wicket.setConfigurationType(RuntimeConfigurationType.DEPLOYMENT);
        // ok: jgates.java.debug-mode-enabled
        vaadin.setProductionMode(true);
        if (isDevProfile) {
            // ok: jgates.java.debug-mode-enabled
            System.setProperty("debug", "true");
        }
    }

    void springBuilder(Object builder) {
        // ruleid: jgates.java.debug-mode-enabled
        builder.properties("debug=true", "logging.level.root=DEBUG");
        // ok: jgates.java.debug-mode-enabled
        builder.properties("debug=false");
    }

    void endpoints(Object http) {
        // ruleid: jgates.java.docs-or-monitoring-endpoint-exposed
        http.authorizeRequests().requestMatchers("/actuator/**").permitAll();
        // ruleid: jgates.java.docs-or-monitoring-endpoint-exposed
        http.authorizeRequests().antMatchers("/swagger-ui/**", "/v3/api-docs/**").permitAll();
        // ruleid: jgates.java.docs-or-monitoring-endpoint-exposed
        http.authorizeRequests().requestMatchers(EndpointRequest.toAnyEndpoint()).permitAll();
        // ok: jgates.java.docs-or-monitoring-endpoint-exposed
        http.authorizeRequests().requestMatchers("/actuator/**").hasRole("ADMIN");
        // ok: jgates.java.docs-or-monitoring-endpoint-exposed
        http.authorizeRequests().requestMatchers("/actuator/health").permitAll();
        // ok: jgates.java.docs-or-monitoring-endpoint-exposed
        http.authorizeRequests().requestMatchers("/public/**").permitAll();
    }

    void listing(Object handler, Object ctx) {
        // ruleid: jgates.java.directory-listing-enabled
        handler.setDirectoriesListed(true);
        // ruleid: jgates.java.directory-listing-enabled
        ctx.setInitParameter("dirAllowed", "true");
        // ruleid: jgates.java.directory-listing-enabled
        ctx.addInitParameter("listings", "true");
        // ruleid: jgates.java.directory-listing-enabled
        handler.setDirectoryListingEnabled(true);
        // ok: jgates.java.directory-listing-enabled
        handler.setDirectoriesListed(false);
        // ok: jgates.java.directory-listing-enabled
        ctx.setInitParameter("dirAllowed", "false");
        // ok: jgates.java.directory-listing-enabled
        ctx.addInitParameter("listings", "false");
    }

    void headers(HttpServletResponse resp, Object config) {
        // ruleid: jgates.java.version-header-exposed
        resp.setHeader("X-Powered-By", "Spring 6.1");
        // ruleid: jgates.java.version-header-exposed
        resp.addHeader("X-Powered-By", "Tomcat");
        // ruleid: jgates.java.version-header-exposed
        config.setSendServerVersion(true);
        // ruleid: jgates.java.version-header-exposed
        config.setSendXPoweredBy(true);
        // ok: jgates.java.version-header-exposed
        config.setSendServerVersion(false);
        // ok: jgates.java.version-header-exposed
        config.setSendXPoweredBy(false);
        // ok: jgates.java.version-header-exposed
        resp.setHeader("Cache-Control", "no-store");
    }

    void massAssignment(HttpServletRequest req, Object user, WebDataBinder binder, ObjectMapper mapper) throws Exception {
        // ruleid: jgates.java.mass-assignment
        BeanUtils.populate(user, req.getParameterMap());
        // ruleid: jgates.java.mass-assignment
        Object form = mapper.convertValue(req.getParameterMap(), Object.class);
        // ruleid: jgates.java.mass-assignment
        binder.setDisallowedFields();
        // ok: jgates.java.mass-assignment
        binder.setAllowedFields("name", "email");
        // ok: jgates.java.mass-assignment
        binder.setDisallowedFields("id", "role");
        // ok: jgates.java.mass-assignment
        BeanUtils.populate(user, Map.of("name", req.getParameter("name")));
        // ok: jgates.java.mass-assignment
        BeanUtils.copyProperty(user, "name", req.getParameter("name"));
    }

    void serializers() {
        ObjectMapper mapper = new ObjectMapper();
        // ruleid: jgates.java.serializer-exposes-all-fields
        mapper.setVisibility(PropertyAccessor.FIELD, Visibility.ANY);
        // ruleid: jgates.java.serializer-exposes-all-fields
        mapper.setVisibility(PropertyAccessor.ALL, JsonAutoDetect.Visibility.ANY);
        // ok: jgates.java.serializer-exposes-all-fields
        mapper.setVisibility(PropertyAccessor.FIELD, Visibility.NONE);
        // ok: jgates.java.serializer-exposes-all-fields
        mapper.setVisibility(PropertyAccessor.FIELD, Visibility.PUBLIC_ONLY);
    }

    // ruleid: jgates.java.serializer-exposes-all-fields
    @JsonAutoDetect(fieldVisibility = Visibility.ANY)
    static class OpenAccount {
        private String owner;
        private String internalNote;
    }

    // ruleid: jgates.java.serializer-exposes-all-fields
    @JsonAutoDetect(fieldVisibility = JsonAutoDetect.Visibility.ANY, getterVisibility = Visibility.NONE)
    static class OpenOrder {
        private String id;
    }

    // ok: jgates.java.serializer-exposes-all-fields
    @JsonAutoDetect(fieldVisibility = Visibility.NONE)
    static class ClosedAccount {
        private String owner;
    }

    // ok: jgates.java.serializer-exposes-all-fields
    static class PlainAccount {
        private String owner;
    }
}
